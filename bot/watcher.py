"""
Watcher upload — jembatan web → Telegram (Telethon), dijalankan DI LAPTOP.

Web hanya menaruh antrian ke tabel `upload_jobs` (path file ada di laptop).
Script ini polling antrian itu, lalu untuk tiap job:
  - game  : split 7-Zip → upload tiap part sebagai dokumen
  - media : upload 1 file sebagai media (Telegram bikin thumbnail)
dengan caption kontrak "Judul | i/total | tags", lalu update progress/status ke DB.
Bot (channel_post) yang meng-index hasilnya — pastikan bot.py juga jalan.

Jalankan & biarkan menyala:
    python watcher.py

Butuh: worker.session (login Telethon, lihat login.py), bot HARUS admin channel,
dan env TG_API_ID/HASH, STORAGE_CHANNEL_ID, TURSO_*, (opsional) SEVENZIP_PATH, WORKER_OUT_DIR.
"""

import asyncio
import os
import subprocess
import tempfile

from dotenv import load_dotenv
from telethon import TelegramClient
import libsql_client

from worker import normalize_tags, build_caption, safe_name, collect_parts

load_dotenv()

API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
STORAGE_CHANNEL_ID = int(os.environ["STORAGE_CHANNEL_ID"])
SESSION = os.environ.get("WORKER_SESSION", "worker")
SEVENZIP = os.environ.get("SEVENZIP_PATH", "7z")
OUT_DIR = os.environ.get("WORKER_OUT_DIR", os.path.join(tempfile.gettempdir(), "tcd_upload_parts"))
POLL_INTERVAL = 5

_turso = os.environ["TURSO_DATABASE_URL"]
if _turso.startswith("libsql://"):
    _turso = "https://" + _turso[len("libsql://"):]
TURSO_URL = _turso
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
async def claim_next(db):
    rs = await db.execute(
        "SELECT id, kind, title, tags, source_path, part_size "
        "FROM upload_jobs WHERE status='pending' ORDER BY id LIMIT 1"
    )
    if not rs.rows:
        return None
    r = rs.rows[0]
    job = {
        "id": r[0], "kind": r[1], "title": r[2],
        "tags": r[3], "path": r[4], "part_size": r[5],
    }
    await db.execute(
        "UPDATE upload_jobs SET status='running', progress=0, message='memulai…', "
        "updated_at=datetime('now') WHERE id=? AND status='pending'",
        [job["id"]],
    )
    return job


async def set_progress(db, jid, pct):
    await db.execute(
        "UPDATE upload_jobs SET progress=?, updated_at=datetime('now') WHERE id=?", [pct, jid]
    )


async def set_status(db, jid, status, message, pct=None):
    if pct is None:
        await db.execute(
            "UPDATE upload_jobs SET status=?, message=?, updated_at=datetime('now') WHERE id=?",
            [status, message, jid],
        )
    else:
        await db.execute(
            "UPDATE upload_jobs SET status=?, message=?, progress=?, updated_at=datetime('now') WHERE id=?",
            [status, message, pct, jid],
        )


# ---------------------------------------------------------------------------
# Split (raise, tidak sys.exit seperti worker.split_with_7zip)
# ---------------------------------------------------------------------------
def split_game(path, title, part_mb):
    os.makedirs(OUT_DIR, exist_ok=True)
    archive = os.path.join(OUT_DIR, f"{safe_name(title)}.7z")
    cmd = [SEVENZIP, "a", f"-v{part_mb}m", "-mx=0", "-y", archive, path]
    print("→ Split:", " ".join(cmd))
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        raise RuntimeError(f"7-Zip tidak ditemukan: '{SEVENZIP}'. Set SEVENZIP_PATH di .env.")
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"7-Zip gagal (exit {e.returncode}).")
    parts = collect_parts(archive)
    if not parts:
        raise RuntimeError("Split selesai tapi tidak ada part ditemukan.")
    return parts


# ---------------------------------------------------------------------------
# Proses satu job
# ---------------------------------------------------------------------------
async def process(client, db, channel, job):
    jid, kind, title = job["id"], job["kind"], job["title"].strip()
    tags = normalize_tags(job["tags"])
    path = job["path"]
    print(f"\n=== Job #{jid}: [{kind}] {title} ←  {path}")

    state = {"pct": 0, "running": True}

    async def updater():
        last = -1
        while state["running"]:
            if state["pct"] != last:
                last = state["pct"]
                await set_progress(db, jid, last)
            await asyncio.sleep(2)

    upd_task = asyncio.create_task(updater())
    try:
        if kind == "game":
            if not os.path.exists(path):
                raise RuntimeError(f"Path tidak ditemukan di laptop: {path}")
            paths = split_game(path, title, int(job["part_size"] or 1500))
            as_document = True
        else:
            if not os.path.isfile(path):
                raise RuntimeError(f"File media tidak ditemukan di laptop: {path}")
            paths = [path]
            as_document = False

        total = len(paths)
        await set_status(db, jid, "running", f"mengunggah {total} part…", 0)

        for i, p in enumerate(paths, start=1):
            caption = build_caption(title, i, total, tags)

            def cb(sent, tot, i=i):
                frac = (sent / tot) if tot else 0
                state["pct"] = min(99, int(((i - 1) + frac) / total * 100))

            print(f"  [{i}/{total}] {os.path.basename(p)}")
            await client.send_file(
                channel, p, caption=caption,
                force_document=as_document, supports_streaming=not as_document,
                progress_callback=cb,
            )

        state["pct"] = 100
        state["running"] = False
        await upd_task

        # Hapus file split yang kita buat (game). File media asli tidak disentuh.
        removed = 0
        if kind == "game":
            for p in paths:
                try:
                    os.remove(p)
                    removed += 1
                except OSError:
                    pass
        msg = f"{total} part terupload" + (f" — {removed} file split dibersihkan" if removed else "")
        await set_status(db, jid, "done", msg, 100)
        print(f"  ✓ Job #{jid} selesai. {msg}")
    except Exception as e:  # noqa: BLE001
        state["running"] = False
        try:
            await upd_task
        except Exception:
            pass
        await set_status(db, jid, "error", str(e)[:300])
        print(f"  ✗ Job #{jid} gagal: {e}")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
async def resolve_channel(client):
    try:
        return await client.get_entity(STORAGE_CHANNEL_ID)
    except Exception:
        async for d in client.iter_dialogs():
            if d.id == STORAGE_CHANNEL_ID:
                return d.entity
    raise RuntimeError(f"Channel {STORAGE_CHANNEL_ID} tidak terakses oleh akun ini.")


async def heartbeat(db, state):
    """Tulis denyut ke Turso tiap 10s → web tahu watcher aktif/tidak."""
    while True:
        try:
            await db.execute(
                "INSERT INTO watcher_heartbeat (id, last_seen, status) "
                "VALUES (1, datetime('now'), ?) "
                "ON CONFLICT(id) DO UPDATE SET last_seen=datetime('now'), status=excluded.status",
                [state["status"]],
            )
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(10)


async def main():
    db = libsql_client.create_client(url=TURSO_URL, auth_token=TURSO_TOKEN)
    state = {"status": "idle"}
    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        channel = await resolve_channel(client)
        hb = asyncio.create_task(heartbeat(db, state))
        print(f"Watcher siap. Channel: {getattr(channel, 'title', channel)}")
        print(f"Output split: {OUT_DIR}")
        print("Polling upload_jobs… (Ctrl+C untuk berhenti)")
        try:
            while True:
                job = await claim_next(db)
                if job:
                    state["status"] = "busy"
                    await process(client, db, channel, job)
                    state["status"] = "idle"
                else:
                    await asyncio.sleep(POLL_INTERVAL)
        finally:
            hb.cancel()


if __name__ == "__main__":
    # Tulis PID → tombol "Matikan watcher" di web bisa menghentikan proses ini.
    pid_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watcher.pid")
    try:
        with open(pid_file, "w") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nWatcher dihentikan.")
    finally:
        try:
            os.remove(pid_file)
        except OSError:
            pass
