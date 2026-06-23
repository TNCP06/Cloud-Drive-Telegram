"""
Upload watcher — bridge between web → Telegram (Telethon). Runs on the laptop OR on
the server (EC2/VPS); the two are interchangeable.

The web inserts rows into `upload_jobs`. This script polls that table and, per job,
uploads to the channel with the caption contract "Title | i/total | tags". There are
two origins:

  - origin='local'  : file already on this machine (source_path = a path).
        archive  → 7-Zip split (folder/archive) → upload each part as a document.
        media → upload the file whole as media (Telegram makes the thumbnail).
        The source is never deleted.

  - origin='upload' : file was pushed via the web's resumable endpoint into a shared
        staging dir (source_path = that dir, cleanup_source=1). NO 7-Zip:
        archive  → if ≤ part_size, one part; else RAW STREAMING SPLIT — read one
                <2 GB window at a time, upload it, delete it (caps disk at ~1 part).
        media → upload the staged file whole as media.
        After success the whole staging dir is deleted. Reassembly on download is a
        plain concat (copy /b a+b > out  |  cat a b > out), not 7-Zip.

Resume: parts_done is a per-part checkpoint. A retried job skips parts already pushed
to Telegram instead of starting over. The bot (channel_post handler) indexes results.

Start and keep running:
    python watcher.py

Requires: worker.session (Telethon login, see login.py), bot MUST be admin in the channel,
env vars TG_API_ID/HASH, STORAGE_CHANNEL_ID, TURSO_*, (optional) SEVENZIP_PATH (local
archives only), WORKER_OUT_DIR (temp split parts).
"""

import asyncio
import base64
import math
import os
import shutil
import subprocess
import tempfile

_VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".3gp"}

from dotenv import load_dotenv
from telethon import TelegramClient
from pg_db import create_client

from worker import normalize_tags, build_caption, safe_name, collect_parts

load_dotenv()

API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
STORAGE_CHANNEL_ID = int(os.environ["STORAGE_CHANNEL_ID"])
SESSION = os.environ.get("WORKER_SESSION", "worker")
SEVENZIP = os.environ.get("SEVENZIP_PATH", "7z")
OUT_DIR = os.environ.get("WORKER_OUT_DIR", os.path.join(tempfile.gettempdir(), "tcd_upload_parts"))
POLL_INTERVAL = 5


# ---------------------------------------------------------------------------
# Thumbnail helpers
# ---------------------------------------------------------------------------
def make_video_thumbnail(path: str) -> "str | None":
    """Extract a frame at 1 s via ffmpeg. Returns temp JPEG path, or None if unavailable/failed."""
    if os.path.splitext(path)[1].lower() not in _VIDEO_EXTS:
        return None
    try:
        thumb_path = path + ".thumb.jpg"
        subprocess.run(
            ["ffmpeg", "-ss", "1", "-i", path,
             "-vframes", "1", "-vf", "scale=320:-2", "-q:v", "5", "-y", thumb_path],
            capture_output=True, timeout=30, check=True,
        )
        if os.path.exists(thumb_path) and os.path.getsize(thumb_path) > 0:
            return thumb_path
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        pass
    return None


def _encode_webp(img_bytes: bytes) -> "tuple[str, str]":
    """Re-encode raw image bytes to compact WebP base64 → (mime, base64).

    Falls back to JPEG passthrough if Pillow is unavailable or decoding fails, so a
    thumbnail is never lost. Mirrors bot.encode_thumbnail (kept local to avoid
    importing bot.py, which requires BOT_TOKEN at import time).
    """
    try:
        from PIL import Image
        import io as _io

        with Image.open(_io.BytesIO(img_bytes)) as img:
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            out = _io.BytesIO()
            img.save(out, format="WEBP", quality=80, method=6)
            return "image/webp", base64.b64encode(out.getvalue()).decode("ascii")
    except Exception:  # noqa: BLE001
        return "image/jpeg", base64.b64encode(img_bytes).decode("ascii")


async def _store_thumbnails(db, thumb_b64: str, thumb_mime: str, channel_msg_ids: list):
    """Background: store the ffmpeg thumbnail once the bot has indexed each part.

    Retries every 10 s for up to 70 s. Uses INSERT OR IGNORE so the bot's own
    harvest (if it succeeds from Telegram's async generation) takes priority.
    """
    for channel_msg_id in channel_msg_ids:
        for attempt in range(7):
            await asyncio.sleep(5 if attempt == 0 else 10)
            try:
                result = await db.execute(
                    "INSERT INTO thumbnails (part_id, mime, data) "
                    "SELECT id, ?, ? FROM parts WHERE channel_msg_id = ? "
                    "ON CONFLICT (part_id) DO NOTHING",
                    [thumb_mime, thumb_b64, channel_msg_id],
                )
                if getattr(result, "rows_affected", 0):
                    print(f"  [thumb] Stored ffmpeg thumbnail for channel_msg_id={channel_msg_id}")
                    break
            except Exception as e:  # noqa: BLE001
                print(f"  [thumb] Retry {attempt + 1} failed for channel_msg_id={channel_msg_id}: {e}")


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
async def claim_next(db):
    rs = await db.execute(
        "SELECT id, kind, title, tags, source_path, part_size, origin, cleanup_source, parts_done "
        "FROM upload_jobs WHERE status='pending' ORDER BY id LIMIT 1"
    )
    if not rs.rows:
        return None
    r = rs.rows[0]
    job = {
        "id": r[0], "kind": r[1], "title": r[2],
        "tags": r[3], "path": r[4], "part_size": r[5],
        "origin": r[6] or "local", "cleanup_source": r[7] or 0, "parts_done": r[8] or 0,
    }
    # Keep parts_done so a retried/resumed job continues from its checkpoint.
    await db.execute(
        "UPDATE upload_jobs SET status='running', message='starting...', "
        "updated_at=now_text() WHERE id=? AND status='pending'",
        [job["id"]],
    )
    return job


async def set_parts_done(db, jid, n):
    await db.execute(
        "UPDATE upload_jobs SET parts_done=?, updated_at=now_text() WHERE id=?", [n, jid]
    )


async def set_progress(db, jid, pct):
    await db.execute(
        "UPDATE upload_jobs SET progress=?, updated_at=now_text() WHERE id=?", [pct, jid]
    )


async def set_status(db, jid, status, message, pct=None):
    if pct is None:
        await db.execute(
            "UPDATE upload_jobs SET status=?, message=?, updated_at=now_text() WHERE id=?",
            [status, message, jid],
        )
    else:
        await db.execute(
            "UPDATE upload_jobs SET status=?, message=?, progress=?, updated_at=now_text() WHERE id=?",
            [status, message, pct, jid],
        )


# ---------------------------------------------------------------------------
# Split (raises, unlike worker.split_with_7zip which calls sys.exit)
# ---------------------------------------------------------------------------
def split_archive(path, title, part_mb):
    os.makedirs(OUT_DIR, exist_ok=True)
    archive = os.path.join(OUT_DIR, f"{safe_name(title)}.7z")
    cmd = [SEVENZIP, "a", f"-v{part_mb}m", "-mx=0", "-y", archive, path]
    print("→ Split:", " ".join(cmd))
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        raise RuntimeError(f"7-Zip not found: '{SEVENZIP}'. Set SEVENZIP_PATH in .env.")
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"7-Zip failed (exit {e.returncode}).")
    parts = collect_parts(archive)
    if not parts:
        raise RuntimeError("Split finished but no parts found.")
    return parts


# ---------------------------------------------------------------------------
# Staged (browser) uploads — no 7-Zip, raw streaming split
# ---------------------------------------------------------------------------
def resolve_staged_file(source_path: str) -> str:
    """source_path is the staging dir for a browser upload — return the single file in it."""
    if os.path.isfile(source_path):
        return source_path  # tolerate a direct file path
    if not os.path.isdir(source_path):
        raise RuntimeError(f"Staged upload not found: {source_path}")
    files = [
        os.path.join(source_path, n)
        for n in sorted(os.listdir(source_path))
        if os.path.isfile(os.path.join(source_path, n))
    ]
    if not files:
        raise RuntimeError(f"No staged file in: {source_path}")
    # Normally exactly one; pick the largest defensively.
    return max(files, key=os.path.getsize)


def write_window(src: str, offset: int, length: int, dst: str) -> None:
    """Copy a byte window [offset, offset+length) of src into dst (8 MB buffer)."""
    buf = 8 * 1024 * 1024
    with open(src, "rb") as f, open(dst, "wb") as o:
        f.seek(offset)
        remaining = length
        while remaining > 0:
            chunk = f.read(min(buf, remaining))
            if not chunk:
                break
            o.write(chunk)
            remaining -= len(chunk)


# ---------------------------------------------------------------------------
# Process a single job
# ---------------------------------------------------------------------------
async def process(client, db, channel, job):
    jid, kind, title = job["id"], job["kind"], job["title"].strip()
    tags = normalize_tags(job["tags"])
    path = job["path"]
    origin = job.get("origin", "local")
    cleanup_source = bool(job.get("cleanup_source", 0))
    parts_done = int(job.get("parts_done", 0) or 0)
    part_mb = int(job["part_size"] or 1500)
    print(f"\n=== Job #{jid}: [{kind}/{origin}] {title} ←  {path}"
          + (f"  (resume from part {parts_done + 1})" if parts_done else ""))

    state = {"pct": 0, "running": True}

    async def updater():
        last = -1
        while state["running"]:
            if state["pct"] != last:
                last = state["pct"]
                await set_progress(db, jid, last)
            await asyncio.sleep(2)

    upd_task = asyncio.create_task(updater())

    # What to clean up at the very end (only on success).
    temp_parts: list[str] = []   # files WE created (local 7-Zip split)
    stream_src: "str | None" = None   # staged file we stream-split (don't pre-split)
    source_dir_to_delete: "str | None" = None  # whole staging dir for browser uploads

    try:
        part_bytes = part_mb * 1024 * 1024

        # ---- Build the upload plan ----------------------------------------
        # plan = ("list", [paths...], as_document)  → upload each path
        #      = ("stream", staged_file, as_document) → raw-split on the fly
        if origin == "upload":
            staged = resolve_staged_file(path)
            
            # Convert webp to jpg automatically if uploaded
            if staged.lower().endswith(".webp"):
                try:
                    from PIL import Image
                    with Image.open(staged) as img:
                        if img.mode not in ("RGB", "L"):
                            img = img.convert("RGB")
                        new_path = staged[:-5] + ".jpg"
                        img.save(new_path, format="JPEG", quality=90)
                    os.remove(staged)
                    staged = new_path
                    if title.lower().endswith(".webp"):
                        title = title[:-5] + ".jpg"
                        await db.execute("UPDATE upload_jobs SET title = ? WHERE id = ?", [title, jid])
                except Exception as e:
                    print(f"  [warn] Failed to convert webp to jpg: {e}")

            if cleanup_source:
                source_dir_to_delete = path if os.path.isdir(path) else None
            if kind == "media":
                plan = ("list", [staged], False)
            else:
                size = os.path.getsize(staged)
                if size <= part_bytes:
                    plan = ("list", [staged], True)
                else:
                    stream_src = staged
                    plan = ("stream", staged, True)
        else:  # local
            if kind == "archive":
                if not os.path.exists(path):
                    raise RuntimeError(f"Path not found: {path}")
                temp_parts = split_archive(path, title, part_mb)
                plan = ("list", temp_parts, True)
            else:
                if not os.path.isfile(path):
                    raise RuntimeError(f"Media file not found: {path}")
                plan = ("list", [path], False)

        as_document = plan[2]
        first_file = plan[1] if plan[0] == "stream" else plan[1][0]
        
        # Telegram treats .webp/.tgs as stickers when force_document=False, which breaks captions.
        if first_file.lower().endswith((".webp", ".tgs", ".webm")):
            as_document = True

        # ---- total parts --------------------------------------------------
        if plan[0] == "stream":
            total = max(1, math.ceil(os.path.getsize(stream_src) / part_bytes))
        else:
            total = len(plan[1])

        if parts_done:
            state["pct"] = min(99, int(parts_done / total * 100))
        await set_status(db, jid, "running", f"uploading {total} part(s)…", state["pct"])

        # ---- thumbnail (media only) --------------------------------------
        thumb_path = make_video_thumbnail(first_file) if kind == "media" else None
        thumb_b64 = None
        thumb_mime = "image/webp"
        if thumb_path:
            try:
                with open(thumb_path, "rb") as f:
                    thumb_mime, thumb_b64 = _encode_webp(f.read())
                print(f"  Thumbnail generated: {os.path.basename(thumb_path)}")
            except OSError:
                thumb_path = None

        def make_cb(i):
            def cb(sent, tot):
                frac = (sent / tot) if tot else 0
                state["pct"] = min(99, int(((i - 1) + frac) / total * 100))
            return cb

        uploaded_msg_ids: list = []
        try:
            if plan[0] == "stream":
                base = os.path.basename(stream_src)
                size = os.path.getsize(stream_src)
                for i in range(parts_done + 1, total + 1):
                    offset = (i - 1) * part_bytes
                    length = min(part_bytes, size - offset)
                    part_path = os.path.join(OUT_DIR, f"{base}.{i:03d}")
                    os.makedirs(OUT_DIR, exist_ok=True)
                    write_window(stream_src, offset, length, part_path)
                    caption = build_caption(title, i, total, tags)
                    print(f"  [{i}/{total}] {os.path.basename(part_path)} ({length} B)")
                    msg = await client.send_file(
                        channel, part_path, caption=caption,
                        force_document=True, progress_callback=make_cb(i),
                    )
                    uploaded_msg_ids.append(msg.id)
                    try:
                        os.remove(part_path)   # free disk immediately
                    except OSError:
                        pass
                    await set_parts_done(db, jid, i)
            else:
                for i, p in enumerate(plan[1], start=1):
                    if i <= parts_done:
                        continue  # already pushed in a previous run
                    caption = build_caption(title, i, total, tags)
                    print(f"  [{i}/{total}] {os.path.basename(p)}")
                    msg = await client.send_file(
                        channel, p, caption=caption,
                        force_document=as_document, supports_streaming=not as_document,
                        thumb=thumb_path,
                        progress_callback=make_cb(i),
                    )
                    uploaded_msg_ids.append(msg.id)
                    await set_parts_done(db, jid, i)
        finally:
            if thumb_path:
                try:
                    os.remove(thumb_path)
                except OSError:
                    pass

        # Store ffmpeg thumbnail directly in Turso as a background task (non-blocking).
        # This is the fallback for when Telegram's async generation doesn't produce one.
        if thumb_b64 and uploaded_msg_ids:
            asyncio.create_task(_store_thumbnails(db, thumb_b64, thumb_mime, uploaded_msg_ids))

        state["pct"] = 100
        state["running"] = False
        await upd_task

        # ---- cleanup (success only) --------------------------------------
        removed = 0
        for p in temp_parts:  # local 7-Zip split files we created
            try:
                os.remove(p)
                removed += 1
            except OSError:
                pass
        if source_dir_to_delete:  # whole staging dir for a browser upload
            shutil.rmtree(source_dir_to_delete, ignore_errors=True)
            removed += 1

        msg = f"{total} part(s) uploaded" + (f" — cleaned up {removed} file(s)" if removed else "")
        await set_status(db, jid, "done", msg, 100)
        print(f"  ✓ Job #{jid} done. {msg}")
    except Exception as e:  # noqa: BLE001
        state["running"] = False
        try:
            await upd_task
        except Exception:
            pass
        await set_status(db, jid, "error", str(e)[:300])
        print(f"  ✗ Job #{jid} failed: {e}")


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
    raise RuntimeError(f"Channel {STORAGE_CHANNEL_ID} is not accessible by this account.")


async def main():
    db = create_client()
    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        channel = await resolve_channel(client)
        print(f"Watcher ready. Channel: {getattr(channel, 'title', channel)}")
        print(f"Split output: {OUT_DIR}")
        print("Polling upload_jobs… (Ctrl+C to stop)")
        while True:
            job = await claim_next(db)
            if job:
                await process(client, db, channel, job)
            else:
                await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    # Write PID → the "Stop watcher" button in the web UI can kill this process.
    pid_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watcher.pid")
    try:
        with open(pid_file, "w") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nWatcher stopped.")
    finally:
        try:
            os.remove(pid_file)
        except OSError:
            pass
