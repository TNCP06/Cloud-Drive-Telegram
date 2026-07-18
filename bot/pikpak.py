"""Generic remote-download feature (in-bot worker) — PikPak + WebDAV drives via OpenList.

Drives are data, not code: `bot_config.DRIVES` maps a command key (pikpak, baidu, …) to an
rclone remote + path prefix. PikPak uses its native `pikpak:` remote; Chinese drives (Baidu,
Quark, 115, …) have no native rclone backend, so they're mounted in a self-hosted OpenList
container exposed over WebDAV (one rclone `webdav` remote `openlist`, prefix = the OpenList
mount name). Adding a drive = one registry entry + two 1-line handlers in bot.py.

Command flow (per drive):
  /<drive> <remote_path>  → validate + size-check via rclone, apply the size policy, insert a
                            `download_jobs` row (status='queued', source=<drive>) + progress msg.
  /pikpak_jobs            → list the last 10 download jobs (all drives) with status.
  /<drive>_ls [folder]    → browse the remote (`rclone lsf`), truncated to ~50 entries.

A pool of in-process worker tasks (PIKPAK_MAX_CONCURRENT, default 1) polls `download_jobs`,
`rclone copy`s the file into the shared staging volume while editing the progress message,
then hands it to the existing `upload_jobs` → watcher pipeline (origin='upload',
cleanup_source=1, status='pending') so the file is pushed to Telegram automatically.

Size policy: media > 2 GB is rejected (a binary-split video can't stream). Non-media > 2 GB is
accepted with part_size=DRIVE_SPLIT_PART_MB, so the watcher raw-splits it into sequential
binary parts (one item, N parts) — reassemble by ordered `cat`. See docs/BUSINESS-FLOWS.md.

This module imports only from bot_config / db_ops (no `bot` import → no import cycle).
"""

import asyncio
import html
import json
import os
import re
import shutil
import time
from collections import deque

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

from bot_config import (
    PIKPAK_MAX_BYTES,
    PIKPAK_STAGING_DIR,
    PIKPAK_MAX_CONCURRENT,
    PIKPAK_RETRIES,
    DRIVE_SPLIT_PART_MB,
    RCLONE_BIN,
    resolve_drive,
    drive_remote,
    log,
)
from db_ops import is_user_authorized

BROWSE_LIMIT = 50           # max entries shown as buttons per folder (Telegram keyboard sanity)

POLL_INTERVAL = 3           # seconds between queue polls (per worker)
EDIT_THROTTLE_S = 6         # min seconds between Telegram progress-message edits (rate-limit safe)
DB_THROTTLE_S = 5           # min seconds between download_jobs progress writes (except on % change)
# Give-up policy for a resumable download. Primary: a no-progress window — abort only if fewer than
# STALL_MIN_BYTES arrive within STALL_WINDOW_S (a slow-but-advancing transfer is left to finish, however
# long it takes). Backstop: an absolute ceiling so nothing runs truly forever.
STALL_WINDOW_S = int(os.environ.get("DRIVE_STALL_WINDOW_S", str(30 * 60)))
STALL_MIN_BYTES = int(os.environ.get("DRIVE_STALL_MIN_MB", "20")) * 1048576
MAX_DL_SECONDS = int(os.environ.get("DRIVE_MAX_DL_SECONDS", str(7 * 24 * 3600)))  # 7d — multi-day safe
_PCT = re.compile(r"(\d+)%")
_SPEED = re.compile(r"([\d.]+\s*[KMGTP]?i?B/s)")   # rclone one-line speed field, e.g. "5.12 MiB/s"
# Strip rclone's "2026/07/12 10:00:00 INFO  : " log prefix → leaves "15 MiB / 1 GiB, 1%, 5 MiB/s, ETA 3m".
_LOG_PREFIX = re.compile(r"^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d\s+\S+\s*:\s*")
_STATUS_ICON = {
    "queued": "🕒", "downloading": "⬇️", "downloaded": "📦",
    "uploading": "⬆️", "done": "✅", "failed": "❌",
}
# media kind → watcher uploads whole as media (streamable video / photo → thumbnail + preview);
# everything else → document. The watcher normalises awkward photo formats (e.g. AVIF saved as
# .jpg) so images keep their thumbnail/preview instead of falling back to a bare document.
_MEDIA_EXTS = {
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".3gp",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp3", ".m4a", ".flac", ".wav", ".ogg",
}


class PikpakError(Exception):
    """A user-facing rclone/PikPak failure (message is safe to send to Telegram)."""


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def human_size(n) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.2f} {unit}"
        n /= 1024


def _is_media(fname: str) -> bool:
    return os.path.splitext(fname)[1].lower() in _MEDIA_EXTS


def _drive_title(remote_path: str, fname: str, drive: dict) -> str:
    """Caption title that files the item under the drive's folder, mirroring the remote
    subfolders. upsert_item splits the title on '/': all but the last segment become nested
    folders, the last is the item name. e.g. remote 'Movies/Action/x.mkv' → 'baidu/Movies/Action/x'.
    """
    base = os.path.splitext(fname)[0] or fname
    remote_dir = os.path.dirname(remote_path).strip("/")
    folder = drive.get("folder") or drive["remote"]
    prefix = folder + (f"/{remote_dir}" if remote_dir else "")
    return f"{prefix}/{base}"


def _classify_rclone_error(stderr: str, path: str, drive: dict) -> str:
    """Turn an rclone stderr dump into a clear, actionable Telegram message."""
    low = stderr.lower()
    remote = drive["remote"]
    name = drive.get("display", remote)
    is_webdav = drive.get("prefix")  # WebDAV drives route through OpenList (prefix set)
    if ("didn't find section" in low or "not found in config" in low
            or "unknown remote" in low or "no such remote" in low):
        return (f"❌ rclone remote '{remote}' is not configured. "
                f"Run `rclone config` on the VPS and set up the '{remote}' remote.")
    # WebDAV/OpenList unreachable → distinct from an expired drive cookie, but both are
    # fixed in the OpenList UI on the VPS, not in the bot.
    if is_webdav and ("connection refused" in low or "connect: " in low
                      or "no such host" in low or "502" in low or "503" in low
                      or "dial tcp" in low or "timeout" in low):
        return (f"❌ OpenList looks unreachable (WebDAV connection failed) for {name}. "
                f"Check the OpenList container is up on the VPS.")
    if ("oauth" in low or "token" in low or "authorization" in low
            or "unauthorized" in low or "401" in low or "403" in low or "invalid_grant" in low):
        if is_webdav:
            return (f"❌ {name} auth failed. The drive cookie has likely expired — re-add / "
                    f"re-authenticate the storage in the OpenList web UI on the VPS.")
        return (f"❌ {name} auth failed. Re-run `rclone config` on the VPS to refresh the "
                f"'{remote}' token.")
    if ("directory not found" in low or "not found" in low
            or "object not found" in low or "doesn't exist" in low):
        return f"❌ Path not found on {name}: {path}"
    return (f"❌ rclone error for {name} ({path}). Check the path, or fix the remote/auth "
            f"({'OpenList UI' if is_webdav else 'rclone config'}) on the VPS.\n{stderr.strip()[:200]}")


async def _run_rclone(args, timeout=120):
    """Run rclone and return (rc, stdout, stderr). Raises PikpakError on missing binary/timeout."""
    try:
        proc = await asyncio.create_subprocess_exec(
            RCLONE_BIN, *args,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise PikpakError(f"❌ rclone binary not found ('{RCLONE_BIN}'). Install rclone on the VPS.")
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise PikpakError("❌ rclone timed out contacting PikPak. Try again.")
    return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


async def rclone_stat(remote_path: str, drive: dict) -> dict:
    """`rclone lsjson --stat` a single path → its JSON object. Raises PikpakError otherwise."""
    rc, out, err = await _run_rclone(["lsjson", "--stat", drive_remote(drive, remote_path)])
    if rc != 0:
        raise PikpakError(_classify_rclone_error(err, remote_path, drive))
    out = out.strip()
    try:
        obj = json.loads(out) if out else None
    except json.JSONDecodeError:
        raise PikpakError(f"❌ Unexpected rclone output for {remote_path}.")
    if not obj:  # rclone returns `null` for a missing path (rc can still be 0)
        raise PikpakError(f"❌ Path not found on {drive.get('display', drive['remote'])}: {remote_path}")
    return obj


async def rclone_lsf(folder: str, drive: dict) -> list:
    """`rclone lsf` a folder → list of names (dirs keep rclone's trailing '/')."""
    rc, out, err = await _run_rclone(["lsf", drive_remote(drive, folder)])
    if rc != 0:
        raise PikpakError(_classify_rclone_error(err, folder, drive))
    return [ln for ln in out.splitlines() if ln.strip()]


def _clean_stats(line: str) -> str:
    """rclone --stats-one-line → the human part: 'size / total, NN%, speed, ETA'."""
    return _LOG_PREFIX.sub("", line).strip()


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


async def _reclaim_orphan_staging(db) -> int:
    """Delete _pikpak staging dirs whose download job is no longer active (done/failed/gone) → free
    disk before rejecting a download. Only numeric job-id dirs are touched; active jobs
    (queued/downloading/downloaded/uploading) and non-job dirs are left alone. Returns bytes freed."""
    try:
        names = os.listdir(PIKPAK_STAGING_DIR)
    except OSError:
        return 0
    rs = await db.execute(
        "SELECT id FROM download_jobs WHERE status IN ('queued','downloading','downloaded','uploading')")
    active = {str(r[0]) for r in rs.rows}
    freed = 0
    for n in names:
        p = os.path.join(PIKPAK_STAGING_DIR, n)
        if n.isdigit() and n not in active and os.path.isdir(p):
            freed += _dir_size(p)
            shutil.rmtree(p, ignore_errors=True)
    return freed


def _resolve_single(dst: str) -> str:
    files = [os.path.join(dst, n) for n in os.listdir(dst)
             if os.path.isfile(os.path.join(dst, n))]
    if not files:
        raise PikpakError("rclone finished but no file was downloaded.")
    return max(files, key=os.path.getsize)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
async def _set(db, jid, *, status=None, progress=None, error=None, speed=None, bytes_done=None):
    cols, vals = [], []
    if status is not None:
        cols.append("status=?"); vals.append(status)
    if progress is not None:
        cols.append("progress=?"); vals.append(progress)
    if error is not None:
        cols.append("error=?"); vals.append(error)
    if speed is not None:
        cols.append("speed=?"); vals.append(speed)
    if bytes_done is not None:
        cols.append("bytes_done=?"); vals.append(bytes_done)
    cols.append("updated_at=now_text()")
    vals.append(jid)
    await db.execute(f"UPDATE download_jobs SET {', '.join(cols)} WHERE id=?", vals)


async def _claim_next(db):
    """Atomically grab the oldest queued job (SKIP LOCKED → safe for >1 concurrent worker)."""
    rs = await db.execute(
        "UPDATE download_jobs SET status='downloading', updated_at=now_text() "
        "WHERE id = (SELECT id FROM download_jobs WHERE status='queued' "
        "            ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) "
        "RETURNING id, remote_path, filename, size, chat_id, message_id, source, bytes_done"
    )
    if not rs.rows:
        return None
    r = rs.rows[0]
    return {"id": r[0], "remote_path": r[1], "filename": r[2],
            "size": r[3], "chat_id": r[4], "message_id": r[5], "source": r[6], "bytes_done": r[7]}


# ---------------------------------------------------------------------------
# Progress-message editing (throttled)
# ---------------------------------------------------------------------------
async def _safe_edit(bot, job, text, state, force=False):
    now = time.monotonic()
    if not force and now - state["last_edit"] < EDIT_THROTTLE_S:
        return
    state["last_edit"] = now
    if not job.get("chat_id") or not job.get("message_id"):
        return
    try:
        await bot.edit_message_text(chat_id=job["chat_id"], message_id=job["message_id"], text=text)
    except Exception:  # noqa: BLE001  (message unchanged / deleted / rate-limited — non-fatal)
        pass


# ---------------------------------------------------------------------------
# The download itself (with retries + backoff)
# ---------------------------------------------------------------------------
def _reserve(path, size):
    """Preallocate `size` bytes up front so the download can't run the disk out mid-transfer and the
    space is committed against other downloads. fallocate (real blocks) → truncate (sparse) fallback.
    Keeps any existing partial content (resume)."""
    if os.path.exists(path) and os.path.getsize(path) >= size:
        return
    with open(path, "r+b" if os.path.exists(path) else "wb") as f:
        try:
            os.posix_fallocate(f.fileno(), 0, size)   # Linux: reserves real blocks
        except (AttributeError, OSError):
            f.truncate(size)                          # non-Linux / no-space: sparse fallback


def _speed_str(nbytes, secs):
    return (human_size(nbytes / secs).replace(" ", "") + "/s") if secs > 0 and nbytes >= 0 else ""


# Permanent — the path/remote is wrong; retrying can never help → fail.
_PERM_ERR_KEYS = ("not found in config", "unknown remote", "didn't find section", "no such remote",
                  "object not found", "directory not found", "doesn't exist")
# Recoverable — the drive cookie expired or OpenList is down; the owner fixes it in the OpenList UI.
# Pause and keep resuming (the partial + bytes_done survive) so it continues once re-authenticated.
_RECOVER_ERR_KEYS = ("401", "403", "unauthorized", "invalid_grant", "oauth",
                     "connection refused", "no such host", "dial tcp", "502", "503")
RECOVER_BACKOFF_S = int(os.environ.get("DRIVE_RECOVER_BACKOFF_S", "300"))  # re-auth wait between retries


async def _rclone_copy(bot, db, job, dst, state, drive):
    """Resumable download. `rclone cat --offset <bytes_done>` streams from the last saved byte into a
    pre-reserved file, so a deploy / restart / transient error / throttle resumes instead of
    restarting from 0. Progress persists in download_jobs.bytes_done. Give up only on a genuine
    no-progress stall (STALL_WINDOW_S) or the absolute backstop (MAX_DL_SECONDS) — a slow-but-advancing
    download is allowed to finish however long it takes."""
    remote = drive_remote(drive, job["remote_path"])
    size = int(job.get("size") or 0)
    fname = job["filename"] or f"download_{job['id']}"
    os.makedirs(dst, exist_ok=True)
    fpath = os.path.join(dst, fname)
    _reserve(fpath, size)

    done = min(int(job.get("bytes_done") or 0), size)
    now = time.monotonic()
    state["spd_bytes"], state["spd_t"] = done, now
    win_bytes, win_t = done, now  # no-progress window anchor

    while done < size:
        try:
            proc = await asyncio.create_subprocess_exec(
                RCLONE_BIN, "cat", remote, "--offset", str(done),
                "--low-level-retries=10", "--timeout=300s", "--contimeout=60s",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            raise PikpakError(f"rclone binary not found ('{RCLONE_BIN}').")
        try:
            with open(fpath, "r+b") as f:
                f.seek(done)
                while True:
                    chunk = await proc.stdout.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    now = time.monotonic()
                    if done - win_bytes >= STALL_MIN_BYTES:  # real progress → reset the stall window
                        win_bytes, win_t = done, now
                    if now - win_t > STALL_WINDOW_S:
                        proc.kill(); await proc.wait()
                        await _set(db, job["id"], bytes_done=done)
                        raise PikpakError(
                            f"⏱ Aborted {fname} — no progress for {STALL_WINDOW_S // 60} min "
                            f"({drive.get('display', drive['remote'])} stalled at {human_size(done)}).")
                    if now - state["start"] > MAX_DL_SECONDS:
                        proc.kill(); await proc.wait()
                        await _set(db, job["id"], bytes_done=done)
                        raise PikpakError(
                            f"⏱ Aborted {fname} — hit the {MAX_DL_SECONDS // 3600}h ceiling at "
                            f"{human_size(done)}/{human_size(size)}.")
                    if now - state["last_db"] >= DB_THROTTLE_S:
                        pct = min(99, int(done / size * 100)) if size else 0
                        spd = _speed_str(done - state["spd_bytes"], now - state["spd_t"])
                        state["spd_bytes"], state["spd_t"], state["last_db"] = done, now, now
                        await _set(db, job["id"], progress=pct, speed=spd, bytes_done=done)
                        await _safe_edit(
                            bot, job, f"⬇️ {fname}\n{human_size(done)} / {human_size(size)} ({pct}%, {spd})", state)
            await proc.wait()
        finally:
            if proc.returncode is None:
                proc.kill(); await proc.wait()
        if proc.returncode == 0 and done >= size:
            break
        # Interruption → persist bytes_done, classify, and either fail, pause-for-re-auth, or resume.
        err = (await proc.stderr.read()).decode("utf-8", "replace")
        await _set(db, job["id"], bytes_done=done)
        low = err.lower()
        if any(k in low for k in _PERM_ERR_KEYS):
            raise PikpakError(_classify_rclone_error(err, job["remote_path"], drive))
        if any(k in low for k in _RECOVER_ERR_KEYS):
            # Auth expired / drive unreachable → pausable, not fatal. Keep the partial and wait for the
            # owner to re-authenticate in OpenList (or the drive to return), then resume. The wait must
            # NOT count as a no-progress stall, so reset the window after backing off.
            await _safe_edit(
                bot, job,
                f"⚠️ {fname} paused at {human_size(done)}/{human_size(size)} — "
                f"{drive.get('display', drive['remote'])} auth/unreachable. Re-authenticate the drive "
                f"in OpenList; the download resumes on its own.", state, force=True)
            await _set(db, job["id"], error="paused: drive auth expired / unreachable — re-auth in OpenList")
            log.warning("PikPak job #%s paused (recoverable) at %s/%s — retrying in %ss",
                        job["id"], done, size, RECOVER_BACKOFF_S)
            await asyncio.sleep(RECOVER_BACKOFF_S)
            win_bytes, win_t = done, time.monotonic()  # auth-wait is not a stall — reset the window
            continue
        log.warning("PikPak job #%s resumable cat interrupted at %s/%s (rc=%s) — resuming",
                    job["id"], done, size, proc.returncode)
        await asyncio.sleep(3)  # brief backoff before resuming
    await _set(db, job["id"], progress=100, bytes_done=done)


async def _process(bot, db, job):
    jid, fname, size = job["id"], job["filename"], job["size"]
    drive = resolve_drive(job.get("source")) or resolve_drive("pikpak")
    dst = os.path.join(PIKPAK_STAGING_DIR, str(jid))
    state = {"last_edit": 0.0, "last_pct": -1, "last_db": 0.0, "start": time.monotonic()}
    await _safe_edit(bot, job, f"⬇️ Downloading {fname} ({human_size(size)}) …", state, force=True)
    try:
        os.makedirs(dst, exist_ok=True)
        # Run-time disk verify before the download reserves the full size: reclaim orphaned staging,
        # then bail if the file still won't fit (disk may have changed since the queue-time guard).
        remaining = int(size) - min(int(job.get("bytes_done") or 0), int(size))
        try:
            free = shutil.disk_usage(PIKPAK_STAGING_DIR).free
        except OSError:
            free = None
        if free is not None and free < remaining:
            await _reclaim_orphan_staging(db)
            free = shutil.disk_usage(PIKPAK_STAGING_DIR).free
        if free is not None and free < remaining:
            raise PikpakError(
                f"❌ Not enough disk to finish {fname}: {human_size(free)} free, "
                f"{human_size(remaining)} still needed.")
        await _rclone_copy(bot, db, job, dst, state, drive)
        _resolve_single(dst)  # sanity: a file actually landed

        # Hand off to the existing upload pipeline. origin='upload' + cleanup_source=1 means
        # the watcher uploads the staged file and deletes `dst` afterwards. Size policy:
        #   media                → single part (4096 MB cap); >2 GB media was rejected up front.
        #   non-media ≤ 2 GB     → single part (4096 MB cap), unchanged from before.
        #   non-media > 2 GB     → part_size = DRIVE_SPLIT_PART_MB so the watcher raw-splits it
        #                          into sequential binary parts (one item, N parts).
        kind = "media" if _is_media(fname) else "archive"  # photo/video → thumbnail+preview; else document
        part_size = DRIVE_SPLIT_PART_MB if (kind == "archive" and size > PIKPAK_MAX_BYTES) else 4096
        title = _drive_title(job["remote_path"], fname, drive)  # files it under the drive folder
        rs = await db.execute(
            "INSERT INTO upload_jobs (kind, title, tags, source_path, part_size, origin, "
            "cleanup_source, total_bytes, status) VALUES (?, ?, '', ?, ?, 'upload', 1, ?, 'pending') "
            "RETURNING id",
            [kind, title, dst, part_size, size],
        )
        upload_id = rs.rows[0][0] if rs.rows else None
        await _set(db, jid, status="downloaded", progress=100)
        await _safe_edit(bot, job, f"✅ Downloaded {fname} — uploading to Telegram…", state, force=True)
        log.info("PikPak job #%s downloaded, handed to upload_jobs #%s", jid, upload_id)
        # Track the upload to completion so /jobs shows 'done' and the staging file is confirmed
        # gone. (cleanup_source=1 already makes the watcher delete it on a successful upload; this
        # updates status + is a defensive backstop.)
        if upload_id:
            asyncio.create_task(_track_upload(bot, db, dict(job), upload_id, dst))
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(dst, ignore_errors=True)  # clean up staging on failure
        await _set(db, jid, status="failed", error=str(e)[:400])
        await _safe_edit(bot, job, f"❌ Failed: {fname}\n{str(e)[:300]}", state, force=True)
        log.warning("PikPak job #%s failed: %s", jid, e)


async def _track_upload(bot, db, job, upload_id, dst):
    """Follow the handed-off upload_job to its terminal state → mark the download job done/failed
    and confirm the staging file is removed. The watcher deletes it (cleanup_source=1); this is a
    status update + backstop. Best-effort: if the bot restarts mid-upload the task is lost, but the
    watcher's cleanup still runs and the file is safely in Telegram regardless."""
    jid, fname = job["id"], job["filename"]
    state = {"last_edit": 0.0, "last_pct": 100}
    await _set(db, jid, status="uploading")
    for _ in range(4 * 60 * 60 // 5):  # poll ≤ ~4h (watcher is serial; a queue backlog can be long)
        await asyncio.sleep(5)
        try:
            rs = await db.execute("SELECT status, message FROM upload_jobs WHERE id=?", [upload_id])
        except Exception:  # noqa: BLE001
            continue
        st = rs.rows[0][0] if rs.rows else None
        detail = rs.rows[0][1] if rs.rows else None  # watcher sets "uploading N part(s)…"
        if st == "done":
            shutil.rmtree(dst, ignore_errors=True)  # backstop; watcher already removed it
            await _set(db, jid, status="done", progress=100)
            await _safe_edit(bot, job, f"✅ {fname} is in the Telegram drive.", state, force=True)
            log.info("PikPak job #%s complete (upload #%s done)", jid, upload_id)
            return
        if st in ("error", "canceled"):
            await _set(db, jid, status="failed", error=f"upload {st}")
            await _safe_edit(bot, job, f"❌ Upload {st}: {fname}", state, force=True)
            return
        # Surface the watcher's whole-file part progress (e.g. "uploading 4 part(s)…").
        if st == "running" and detail:
            await _safe_edit(bot, job, f"⬆️ {fname} — {detail}", state)
        if st is None:
            return  # upload row gone — stop quietly
    log.warning("PikPak job #%s: upload #%s still not terminal after poll cap", jid, upload_id)


# ---------------------------------------------------------------------------
# Worker pool + schema/lifecycle
# ---------------------------------------------------------------------------
async def _worker_loop(bot, db):
    while True:
        try:
            job = await _claim_next(db)
            if job:
                await _process(bot, db, job)
            else:
                await asyncio.sleep(POLL_INTERVAL)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001  (never let the loop die)
            log.warning("PikPak worker loop error: %s", e)
            await asyncio.sleep(POLL_INTERVAL)


async def ensure_schema(db):
    """Idempotent auto-migration (existing DBs) + requeue jobs stranded by a bot restart.

    schema.sql already creates this on a fresh volume; this mirrors it so an already-running
    Postgres gets the table/trigger on the next boot. Kept in sync with schema.sql.
    """
    await db.execute("""
        CREATE TABLE IF NOT EXISTS download_jobs (
            id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            source      TEXT NOT NULL DEFAULT 'pikpak',
            remote_path TEXT NOT NULL,
            filename    TEXT NOT NULL,
            size        BIGINT NOT NULL DEFAULT 0,
            status      TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','downloading','downloaded','uploading','done','failed')),
            progress    INTEGER NOT NULL DEFAULT 0,
            speed       TEXT,
            bytes_done  BIGINT NOT NULL DEFAULT 0,
            error       TEXT,
            chat_id     BIGINT,
            message_id  BIGINT,
            created_at  TEXT NOT NULL DEFAULT now_text(),
            updated_at  TEXT NOT NULL DEFAULT now_text()
        )
    """)
    await db.execute("CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status)")
    await db.execute("ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS speed TEXT")            # existing DBs
    await db.execute("ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS bytes_done BIGINT NOT NULL DEFAULT 0")
    await db.execute(
        "CREATE OR REPLACE FUNCTION notify_pikpak_change() RETURNS trigger "
        "LANGUAGE plpgsql AS $func$ BEGIN "
        "PERFORM pg_notify('pikpak_changed', TG_TABLE_NAME); RETURN NULL; END $func$"
    )
    await db.execute("DROP TRIGGER IF EXISTS trg_notify_download_jobs ON download_jobs")
    await db.execute(
        "CREATE TRIGGER trg_notify_download_jobs AFTER INSERT OR UPDATE OR DELETE ON download_jobs "
        "FOR EACH STATEMENT EXECUTE FUNCTION notify_pikpak_change()"
    )
    # A job left mid-download by a crash → requeue (rclone copy is idempotent into the same dir).
    await db.execute(
        "UPDATE download_jobs SET status='queued', progress=0, updated_at=now_text() "
        "WHERE status='downloading'"
    )


def start_workers(app):
    """Spawn the download worker task(s). Call from post_init once the DB is ready."""
    db = app.bot_data["db"]
    n = max(1, PIKPAK_MAX_CONCURRENT)
    app.bot_data["pikpak_workers"] = [
        asyncio.create_task(_worker_loop(app.bot, db)) for _ in range(n)
    ]
    log.info("PikPak: started %d download worker(s)", n)


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------
async def _deny(message, user_id):
    await message.reply_text(
        f"⛔ Not authorized. Use `/auth <password>` or ask the owner.\nYour Telegram ID: `{user_id}`",
        parse_mode="Markdown",
    )


# --- Reusable cores (shared by the /commands and the PikPak menu buttons) ----
async def start_download(message, db, remote_path, drive_key="pikpak"):
    """Validate a drive path, apply the size policy, queue a download job + progress reply.

    Size policy: media > 2 GB is rejected (a binary-split media file can't be streamed);
    non-media > 2 GB is accepted and later split into parts by the watcher.
    """
    drive = resolve_drive(drive_key)
    if not drive:
        await message.reply_text(f"❌ Unknown drive '{drive_key}'.")
        return
    name = drive.get("display", drive_key)
    remote_path = (remote_path or "").strip().strip("/")
    if not remote_path:
        await message.reply_text("No path given. Example: `My Pack/delyn.jpg`.", parse_mode="Markdown")
        return
    try:
        entry = await rclone_stat(remote_path, drive)
    except PikpakError as e:
        await message.reply_text(str(e))
        return
    if entry.get("IsDir"):
        await message.reply_text(
            f"“{remote_path}” is a folder — /{drive_key} takes a single file. Browse it with "
            f"`/{drive_key}_ls {remote_path}`.", parse_mode="Markdown")
        return
    size = int(entry.get("Size") or 0)
    fname = entry.get("Name") or os.path.basename(remote_path) or remote_path
    if size <= 0:
        await message.reply_text(f"❌ Couldn't determine the file size on {name} — aborting.")
        return
    if size > PIKPAK_MAX_BYTES and _is_media(fname):
        await message.reply_text(
            f"❌ {fname} is {human_size(size)}, over the {human_size(PIKPAK_MAX_BYTES)} Telegram limit. "
            "Media files can't be split (a split video won't stream/play), so it's rejected. "
            "Only non-media files are split and uploaded in parts.")
        return
    # Disk-guard: refuse up front if the staging volume can't hold the file + split/handoff overhead,
    # so a big download can't fill the disk (bricking postgres/streamer/web) then fail. 1.2× covers a
    # split part staged alongside the whole file. ponytail: queue-time only — add a worker-start recheck
    # if concurrent downloads (PIKPAK_MAX_CONCURRENT>1) ever make between-queue-and-run depletion real.
    need = int(size * 1.2)
    try:
        os.makedirs(PIKPAK_STAGING_DIR, exist_ok=True)
        free = shutil.disk_usage(PIKPAK_STAGING_DIR).free
    except OSError:
        free = None
    reclaimed = 0
    if free is not None and free < need:
        # Don't reject outright — bin orphaned staging (junk from done/failed jobs) first, then re-check.
        reclaimed = await _reclaim_orphan_staging(db)
        if reclaimed:
            free = shutil.disk_usage(PIKPAK_STAGING_DIR).free
    if free is not None and free < need:
        note = f" (freed {human_size(reclaimed)} of junk first)" if reclaimed else ""
        await message.reply_text(
            f"❌ Not enough disk for {fname} ({human_size(size)}){note}. "
            f"Free: {human_size(free)}, need ~{human_size(need)}. "
            f"Delete some stored files or clear the video cache on the server, then retry.")
        return
    split_note = " (will be uploaded in parts)" if size > PIKPAK_MAX_BYTES else ""
    sent = await message.reply_text(f"🗂 Queued {fname} ({human_size(size)}){split_note} for download…")
    rs = await db.execute(
        "INSERT INTO download_jobs (source, remote_path, filename, size, status, chat_id, message_id) "
        "VALUES (?, ?, ?, ?, 'queued', ?, ?) RETURNING id",
        [drive_key, remote_path, fname, size, sent.chat_id, sent.message_id],
    )
    jid = rs.rows[0][0] if rs.rows else "?"
    log.info("%s job #%s queued: %s (%s)", name, jid, remote_path, human_size(size))


async def do_ls(message, folder, drive_key="pikpak"):
    """List a drive folder (≤50 entries)."""
    drive = resolve_drive(drive_key)
    if not drive:
        await message.reply_text(f"❌ Unknown drive '{drive_key}'.")
        return
    folder = (folder or "").strip().strip("/")
    if folder in (".", "/"):
        folder = ""
    try:
        names = await rclone_lsf(folder, drive)
    except PikpakError as e:
        await message.reply_text(str(e))
        return
    loc = drive_remote(drive, folder) or f"{drive['remote']}:/"
    if not names:
        await message.reply_text(f"📂 {loc} is empty.")
        return
    shown = names[:50]
    more = f"\n… ({len(names) - 50} more)" if len(names) > 50 else ""
    header = f"📁 {loc}  ({len(names)} entries)\n\n"
    # Plain text (no parse_mode): filenames can contain markdown/HTML-breaking chars.
    await message.reply_text(header + "\n".join(shown) + more)


async def jobs_text(db) -> str:
    """HTML listing of the last 10 download jobs (shared by /pikpak_jobs + menu button)."""
    rs = await db.execute(
        "SELECT id, filename, size, status, progress, error, source, speed "
        "FROM download_jobs ORDER BY id DESC LIMIT 10"
    )
    if not rs.rows:
        return "No download jobs yet. Start one with /pikpak &lt;path&gt; or /baidu &lt;path&gt;."
    lines = ["📋 <b>Last 10 download jobs</b>"]
    for jid, fname, size, status, progress, error, source, speed in rs.rows:
        icon = _STATUS_ICON.get(status, "•")
        drive = resolve_drive(source)
        tag = f"[{html.escape(drive['display'] if drive else str(source))}] "
        extra = (f" {progress}%" + (f" · {html.escape(speed)}" if speed else "")) if status == "downloading" else ""
        tail = f" — {html.escape(error[:60])}" if status == "failed" and error else ""
        lines.append(f"{icon} #{jid} {tag}{html.escape(str(fname))} ({human_size(size)}) [{status}{extra}]{tail}")
    return "\n".join(lines)


# --- Thin command handlers ---------------------------------------------------
# Generic cores parameterised by drive_key; per-drive commands are thin wrappers so adding a
# drive = a registry entry + two 1-line handlers registered in bot.py.
async def _cmd_download(update, context, drive_key):
    user, message = update.effective_user, update.message
    if message is None or user is None:
        return
    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        await _deny(message, user.id)
        return
    if not context.args:
        await message.reply_text(
            f"Usage: `/{drive_key} <remote_path>`\nBrowse paths with `/{drive_key}_ls [folder]`.",
            parse_mode="Markdown")
        return
    await start_download(message, db, " ".join(context.args), drive_key)


async def _cmd_ls(update, context, drive_key):
    user, message = update.effective_user, update.message
    if message is None or user is None:
        return
    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        await _deny(message, user.id)
        return
    await do_ls(message, " ".join(context.args) if context.args else "", drive_key)


async def on_pikpak(update, context):
    await _cmd_download(update, context, "pikpak")


async def on_ls(update, context):
    await _cmd_ls(update, context, "pikpak")


async def on_baidu(update, context):
    await _cmd_download(update, context, "baidu")


async def on_baidu_ls(update, context):
    await _cmd_ls(update, context, "baidu")


async def on_jobs(update, context):
    user, message = update.effective_user, update.message
    if message is None or user is None:
        return
    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        await _deny(message, user.id)
        return
    await message.reply_text(await jobs_text(db), parse_mode="HTML")


# --- Interactive button browser (navigate folders / tap a file to download) --
# The current folder + its listing are cached in user_data so callback_data can carry a tiny
# index (pk:cd:N / pk:dl:N) instead of a full path — Telegram caps callback_data at 64 bytes.
async def render_browser(query, context, folder, drive_key="pikpak"):
    """Edit the browse message to show `folder`'s entries as buttons (📁 open / 📄 download).
    Works for any registry drive; the active drive is cached in user_data so the pk:* callbacks
    (which only carry a tiny index) know which drive to act on."""
    drive = resolve_drive(drive_key) or resolve_drive("pikpak")
    back = f"drive:menu:{drive_key}"
    folder = (folder or "").strip().strip("/")
    context.user_data["pk_drive"] = drive_key
    try:
        names = await rclone_lsf(folder, drive)
    except PikpakError as e:
        kb = [[InlineKeyboardButton(f"⬅️ {drive.get('display', drive_key)} menu", callback_data=back)]]
        await query.edit_message_text(str(e), reply_markup=InlineKeyboardMarkup(kb))
        return
    shown = names[:BROWSE_LIMIT]
    context.user_data["pk_cwd"] = folder
    context.user_data["pk_items"] = shown
    rows = []
    if folder:
        rows.append([InlineKeyboardButton("⬆️  .. (up)", callback_data="pk:up")])
    for idx, name in enumerate(shown):
        is_dir = name.endswith("/")
        label = ("📁 " if is_dir else "📄 ") + name.rstrip("/")[:38]
        rows.append([InlineKeyboardButton(label, callback_data=f"pk:{'cd' if is_dir else 'dl'}:{idx}")])
    rows.append([InlineKeyboardButton(f"⬅️ {drive.get('display', drive_key)} menu", callback_data=back)])
    more = (f"\n… and {len(names) - BROWSE_LIMIT} more — narrow with /{drive_key}_ls {folder}"
            if len(names) > BROWSE_LIMIT else "")
    loc = drive_remote(drive, folder) or f"{drive['remote']}:/"
    header = (f"📂 <b>{html.escape(loc)}</b>\n"
              f"Tap 📁 to open a folder, 📄 to download a file.{html.escape(more)}")
    await query.edit_message_text(header, reply_markup=InlineKeyboardMarkup(rows), parse_mode="HTML")


async def browse_navigate(query, context, data, db):
    """Handle a pk:* browser callback (pk:up / pk:cd:N / pk:dl:N) for the cached active drive."""
    drive_key = context.user_data.get("pk_drive", "pikpak")
    cwd = context.user_data.get("pk_cwd", "")
    items = context.user_data.get("pk_items", [])
    if data == "pk:up":
        parent = cwd.rsplit("/", 1)[0] if "/" in cwd else ""
        await render_browser(query, context, parent, drive_key)
        return
    try:
        _, action, idx_s = data.split(":", 2)
        name = items[int(idx_s)]
    except (ValueError, IndexError):
        await render_browser(query, context, cwd, drive_key)  # stale listing — re-list current folder
        return
    path = (f"{cwd}/{name}" if cwd else name).strip("/")
    if action == "cd":
        await render_browser(query, context, path, drive_key)
    elif action == "dl":
        await start_download(query.message, db, path, drive_key)
