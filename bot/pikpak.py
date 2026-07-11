"""PikPak remote-download feature (in-bot worker).

Command flow:
  /pikpak <remote_path>  → validate + size-check via rclone, reject if oversized, insert a
                           `download_jobs` row (status='queued') and reply a progress message.
  /jobs                  → list the last 10 download jobs with status.
  /ls [folder]           → browse the remote (`rclone lsf`), truncated to ~50 entries.

A pool of in-process worker tasks (PIKPAK_MAX_CONCURRENT, default 1) polls `download_jobs`,
`rclone copy`s the file into the shared staging volume while editing the progress message,
then hands it to the existing `upload_jobs` → watcher pipeline (origin='upload',
cleanup_source=1, status='pending') so the file is pushed to Telegram automatically. Because
oversized files are rejected up front, every accepted file is a single part — nothing is split.

This module imports only from bot_config / db_ops (no `bot` import → no import cycle).
"""

import asyncio
import json
import os
import re
import shutil
import time
from collections import deque

from bot_config import (
    PIKPAK_REMOTE,
    PIKPAK_MAX_BYTES,
    PIKPAK_STAGING_DIR,
    PIKPAK_MAX_CONCURRENT,
    PIKPAK_RETRIES,
    PIKPAK_DRIVE_FOLDER,
    RCLONE_BIN,
    log,
)
from db_ops import is_user_authorized

POLL_INTERVAL = 3           # seconds between queue polls (per worker)
EDIT_THROTTLE_S = 6         # min seconds between Telegram progress-message edits (rate-limit safe)
_PCT = re.compile(r"(\d+)%")
# Strip rclone's "2026/07/12 10:00:00 INFO  : " log prefix → leaves "15 MiB / 1 GiB, 1%, 5 MiB/s, ETA 3m".
_LOG_PREFIX = re.compile(r"^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d\s+\S+\s*:\s*")
_STATUS_ICON = {
    "queued": "🕒", "downloading": "⬇️", "downloaded": "📦",
    "uploading": "⬆️", "done": "✅", "failed": "❌",
}
# Only VIDEO → 'media' (streamable, thumbnail). Everything else — images, audio, archives,
# docs — uploads as a DOCUMENT: preserves the original bytes (Telegram recompresses photos and
# rejects unusual image formats like AVIF-as-.jpg with "Failure while processing image"), which
# is what a cloud drive wants.
_VIDEO_EXTS = {
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".3gp",
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


def _is_video(fname: str) -> bool:
    return os.path.splitext(fname)[1].lower() in _VIDEO_EXTS


def _drive_title(remote_path: str, fname: str) -> str:
    """Caption title that files the item under the drive's pikpak folder, mirroring the remote
    subfolders. upsert_item splits the title on '/': all but the last segment become nested
    folders, the last is the item name. e.g. remote 'Movies/Action/x.mkv' → 'pikpak/Movies/Action/x'.
    """
    base = os.path.splitext(fname)[0] or fname
    remote_dir = os.path.dirname(remote_path).strip("/")
    prefix = PIKPAK_DRIVE_FOLDER + (f"/{remote_dir}" if remote_dir else "")
    return f"{prefix}/{base}"


def _classify_rclone_error(stderr: str, path: str) -> str:
    """Turn an rclone stderr dump into a clear, actionable Telegram message."""
    low = stderr.lower()
    if ("didn't find section" in low or "not found in config" in low
            or "unknown remote" in low or "no such remote" in low):
        return (f"❌ rclone remote '{PIKPAK_REMOTE}' is not configured. "
                f"Run `rclone config` on the VPS and set up the '{PIKPAK_REMOTE}' remote.")
    if ("oauth" in low or "token" in low or "authorization" in low
            or "unauthorized" in low or "401" in low or "invalid_grant" in low):
        return (f"❌ PikPak auth failed. Re-run `rclone config` on the VPS to refresh the "
                f"'{PIKPAK_REMOTE}' token.")
    if ("directory not found" in low or "not found" in low
            or "object not found" in low or "doesn't exist" in low):
        return f"❌ Path not found on {PIKPAK_REMOTE}: {path}"
    return (f"❌ rclone error for {PIKPAK_REMOTE}:{path}. Check the path, or run `rclone config` "
            f"on the VPS if the remote/auth is broken.\n{stderr.strip()[:200]}")


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


async def rclone_stat(remote_path: str) -> dict:
    """`rclone lsjson --stat` a single path → its JSON object. Raises PikpakError otherwise."""
    rc, out, err = await _run_rclone(["lsjson", "--stat", f"{PIKPAK_REMOTE}:{remote_path}"])
    if rc != 0:
        raise PikpakError(_classify_rclone_error(err, remote_path))
    out = out.strip()
    try:
        obj = json.loads(out) if out else None
    except json.JSONDecodeError:
        raise PikpakError(f"❌ Unexpected rclone output for {remote_path}.")
    if not obj:  # rclone returns `null` for a missing path (rc can still be 0)
        raise PikpakError(f"❌ Path not found on {PIKPAK_REMOTE}: {remote_path}")
    return obj


async def rclone_lsf(folder: str) -> list:
    """`rclone lsf` a folder → list of names (dirs keep rclone's trailing '/')."""
    rc, out, err = await _run_rclone(["lsf", f"{PIKPAK_REMOTE}:{folder}"])
    if rc != 0:
        raise PikpakError(_classify_rclone_error(err, folder))
    return [ln for ln in out.splitlines() if ln.strip()]


def _clean_stats(line: str) -> str:
    """rclone --stats-one-line → the human part: 'size / total, NN%, speed, ETA'."""
    return _LOG_PREFIX.sub("", line).strip()


def _resolve_single(dst: str) -> str:
    files = [os.path.join(dst, n) for n in os.listdir(dst)
             if os.path.isfile(os.path.join(dst, n))]
    if not files:
        raise PikpakError("rclone finished but no file was downloaded.")
    return max(files, key=os.path.getsize)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
async def _set(db, jid, *, status=None, progress=None, error=None):
    cols, vals = [], []
    if status is not None:
        cols.append("status=?"); vals.append(status)
    if progress is not None:
        cols.append("progress=?"); vals.append(progress)
    if error is not None:
        cols.append("error=?"); vals.append(error)
    cols.append("updated_at=now_text()")
    vals.append(jid)
    await db.execute(f"UPDATE download_jobs SET {', '.join(cols)} WHERE id=?", vals)


async def _claim_next(db):
    """Atomically grab the oldest queued job (SKIP LOCKED → safe for >1 concurrent worker)."""
    rs = await db.execute(
        "UPDATE download_jobs SET status='downloading', updated_at=now_text() "
        "WHERE id = (SELECT id FROM download_jobs WHERE status='queued' "
        "            ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) "
        "RETURNING id, remote_path, filename, size, chat_id, message_id"
    )
    if not rs.rows:
        return None
    r = rs.rows[0]
    return {"id": r[0], "remote_path": r[1], "filename": r[2],
            "size": r[3], "chat_id": r[4], "message_id": r[5]}


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
async def _rclone_copy(bot, db, job, dst, state):
    remote = f"{PIKPAK_REMOTE}:{job['remote_path']}"
    last_err = ""
    for attempt in range(1, PIKPAK_RETRIES + 1):
        try:
            proc = await asyncio.create_subprocess_exec(
                RCLONE_BIN, "copy", remote, dst,
                "--stats=1s", "--stats-one-line", "--transfers=1",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            raise PikpakError(f"rclone binary not found ('{RCLONE_BIN}').")
        tail = deque(maxlen=8)
        async for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            tail.append(line)
            m = _PCT.search(line)
            if m:
                pct = min(99, int(m.group(1)))
                if pct != state["last_pct"]:
                    state["last_pct"] = pct
                    await _set(db, job["id"], progress=pct)
                    # Show rclone's own size/percent/speed/ETA line (throttled edit).
                    await _safe_edit(bot, job, f"⬇️ {job['filename']}\n{_clean_stats(line)}", state)
        await proc.wait()
        if proc.returncode == 0:
            return
        last_err = "\n".join(tail)[-400:]
        log.warning("PikPak job #%s rclone attempt %s/%s failed (rc=%s)",
                    job["id"], attempt, PIKPAK_RETRIES, proc.returncode)
        if attempt < PIKPAK_RETRIES:
            await asyncio.sleep(min(30, 2 ** attempt))  # backoff: 2s, 4s, 8s…
    raise PikpakError(f"rclone copy failed after {PIKPAK_RETRIES} attempts.\n{last_err}")


async def _process(bot, db, job):
    jid, fname, size = job["id"], job["filename"], job["size"]
    dst = os.path.join(PIKPAK_STAGING_DIR, str(jid))
    state = {"last_edit": 0.0, "last_pct": -1}
    await _safe_edit(bot, job, f"⬇️ Downloading {fname} ({human_size(size)}) …", state, force=True)
    try:
        os.makedirs(dst, exist_ok=True)
        await _rclone_copy(bot, db, job, dst, state)
        _resolve_single(dst)  # sanity: a file actually landed

        # Hand off to the existing upload pipeline. origin='upload' + cleanup_source=1 means
        # the watcher uploads the staged file whole and deletes `dst` afterwards. part_size is
        # oversized-proof (4096 MB) so a ≤2 GB file is always one part (no split).
        kind = "media" if _is_video(fname) else "archive"  # video → streamable; else document
        title = _drive_title(job["remote_path"], fname)  # files it under the pikpak/ drive folder
        rs = await db.execute(
            "INSERT INTO upload_jobs (kind, title, tags, source_path, part_size, origin, "
            "cleanup_source, total_bytes, status) VALUES (?, ?, '', ?, 4096, 'upload', 1, ?, 'pending') "
            "RETURNING id",
            [kind, title, dst, size],
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
            rs = await db.execute("SELECT status FROM upload_jobs WHERE id=?", [upload_id])
        except Exception:  # noqa: BLE001
            continue
        st = rs.rows[0][0] if rs.rows else None
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
            error       TEXT,
            chat_id     BIGINT,
            message_id  BIGINT,
            created_at  TEXT NOT NULL DEFAULT now_text(),
            updated_at  TEXT NOT NULL DEFAULT now_text()
        )
    """)
    await db.execute("CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status)")
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


async def on_pikpak(update, context):
    user = update.effective_user
    message = update.message
    if message is None or user is None:
        return
    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        await _deny(message, user.id)
        return
    if not context.args:
        await message.reply_text("Usage: `/pikpak <remote_path>`\nBrowse paths with `/ls [folder]`.",
                                 parse_mode="Markdown")
        return

    remote_path = " ".join(context.args).strip().strip("/")
    try:
        entry = await rclone_stat(remote_path)
    except PikpakError as e:
        await message.reply_text(str(e))
        return

    if entry.get("IsDir"):
        await message.reply_text(
            f"“{remote_path}” is a folder. /pikpak takes a single file — list it with `/ls {remote_path}`.",
            parse_mode="Markdown")
        return
    size = int(entry.get("Size") or 0)
    fname = entry.get("Name") or os.path.basename(remote_path) or remote_path
    if size <= 0:
        await message.reply_text("❌ Couldn't determine the file size on PikPak — aborting.")
        return
    if size > PIKPAK_MAX_BYTES:
        await message.reply_text(
            f"❌ File is {human_size(size)}, exceeds the {human_size(PIKPAK_MAX_BYTES)} Telegram limit. "
            "Not downloaded.")
        return

    sent = await message.reply_text(f"🗂 Queued {fname} ({human_size(size)}) for download…")
    rs = await db.execute(
        "INSERT INTO download_jobs (source, remote_path, filename, size, status, chat_id, message_id) "
        "VALUES ('pikpak', ?, ?, ?, 'queued', ?, ?) RETURNING id",
        [remote_path, fname, size, sent.chat_id, sent.message_id],
    )
    jid = rs.rows[0][0] if rs.rows else "?"
    log.info("PikPak job #%s queued: %s (%s)", jid, remote_path, human_size(size))


async def on_jobs(update, context):
    user = update.effective_user
    message = update.message
    if message is None or user is None:
        return
    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        await _deny(message, user.id)
        return
    rs = await db.execute(
        "SELECT id, filename, size, status, progress, error "
        "FROM download_jobs ORDER BY id DESC LIMIT 10"
    )
    if not rs.rows:
        await message.reply_text("No download jobs yet. Start one with `/pikpak <path>`.",
                                 parse_mode="Markdown")
        return
    lines = ["📋 <b>Last 10 download jobs</b>"]
    for jid, fname, size, status, progress, error in rs.rows:
        icon = _STATUS_ICON.get(status, "•")
        extra = f" {progress}%" if status == "downloading" else ""
        tail = f" — {error[:60]}" if status == "failed" and error else ""
        lines.append(f"{icon} #{jid} {fname} ({human_size(size)}) [{status}{extra}]{tail}")
    await message.reply_text("\n".join(lines), parse_mode="HTML")


async def on_ls(update, context):
    user = update.effective_user
    message = update.message
    if message is None or user is None:
        return
    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        await _deny(message, user.id)
        return
    folder = " ".join(context.args).strip().strip("/") if context.args else ""
    try:
        names = await rclone_lsf(folder)
    except PikpakError as e:
        await message.reply_text(str(e))
        return
    if not names:
        await message.reply_text(f"📂 {PIKPAK_REMOTE}:{folder or '/'} is empty.")
        return
    shown = names[:50]
    more = f"\n… ({len(names) - 50} more)" if len(names) > 50 else ""
    header = f"📁 {PIKPAK_REMOTE}:{folder or '/'}  ({len(names)} entries)\n\n"
    # Plain text (no parse_mode): filenames can contain markdown/HTML-breaking chars.
    await message.reply_text(header + "\n".join(shown) + more)
