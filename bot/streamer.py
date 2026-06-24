"""
Telegram Cloud Drive — video streaming server (FastAPI + Telethon).

Streams single-part media files stored in a private Telegram channel over HTTP
with standard Range-request support (206 Partial Content). Designed for browser
<video> playback with YouTube-style chunked delivery.

Architecture:
  - Sparse chunk cache on disk: each part gets a directory with a meta.json and
    individual chunk files (chunk_000000, chunk_000001, …). Chunks are 1 MB by
    default, matching YouTube's chunk size for responsive seeking.
  - Background prefetch: after serving a chunk, a background task downloads the
    next N chunks ahead (16 MB default) so sequential playback never stalls.
  - LRU cache eviction: when the cache exceeds CACHE_MAX_SIZE_GB (15 GB default),
    the least-recently-accessed *entire part directory* is evicted.
  - Telethon message cache: in-memory dict avoids redundant get_messages calls.

Endpoints:
  GET /stream/{part_id}  — serve video bytes (206 Partial Content)
  GET /health            — simple health check
  GET /logs              — view recent logs

Run:
  python streamer.py
  # or: uvicorn bot.streamer:app --host 0.0.0.0 --port 8080
"""

import asyncio
import json
import logging
import os
import re
import shutil
import time
from collections import defaultdict, deque
from contextlib import aclosing, asynccontextmanager
from pathlib import Path

import httpx
from pg_db import create_client, PgClient
import uvicorn
import telethon.errors
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse
from telethon import TelegramClient
from telethon.utils import pack_bot_file_id

# Background video compression + local-file range serving live in their own module.
from stream_compress import (
    COMPRESSED_DIR,
    VIDEO_COMPRESS,
    VIDEO_CRF,
    VIDEO_PRESET,
    init_semaphore,
    _compressed_path,
    _serve_local_file_range,
    _schedule_transcode,
)

# Background subtitle generation (Groq Whisper STT + translation) lives in its own module.
from stream_subtitles import (
    SUBTITLE_GEN,
    SUBTITLES_DIR,
    GROQ_API_KEYS,
    SUBTITLE_BACKFILL,
    SUBTITLE_BACKFILL_INTERVAL_S,
    SUBTITLE_BACKFILL_IDLE_S,
    SUBTITLE_BACKFILL_START_DELAY_S,
    init_subtitle_semaphore,
    is_subtitled_done,
    is_subtitle_partial,
    partial_part_ids,
    run_subtitle_job,
    repair_translations_on_disk,
    available_langs,
    subtitle_path,
    stt_available,
)

# Seek-preview sprite-sheet generation (ffmpeg thumbnails for Plyr progress-bar hover).
from stream_seekpreview import (
    SEEKPREVIEW_DIR,
    init_seekpreview_semaphore,
    has_preview,
    vtt_path as seekpreview_vtt_path,
    sprite_path as seekpreview_sprite_path,
    generate_seek_preview,
)

# ---------------------------------------------------------------------------
# In-memory log buffer for debugging
# ---------------------------------------------------------------------------
class MemoryHandler(logging.Handler):
    def __init__(self, capacity=100):
        super().__init__()
        self.buffer = deque(maxlen=capacity)
    
    def emit(self, record):
        self.buffer.append(self.format(record))

mem_handler = MemoryHandler(capacity=200)
mem_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(), mem_handler]
)
log = logging.getLogger("streamer")

# ---------------------------------------------------------------------------
# Configuration & environment
# ---------------------------------------------------------------------------
load_dotenv()

API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
STORAGE_CHANNEL_ID = int(os.environ["STORAGE_CHANNEL_ID"])
OWNER_USER_ID = int(os.environ["OWNER_USER_ID"])
SESSION = os.environ.get("STREAMER_SESSION", "streamer")
BOT_TOKEN = os.environ.get("BOT_TOKEN")
TELEGRAM_API_URL = os.environ.get("TELEGRAM_API_URL")

CACHE_DIR = Path(os.environ.get("CACHE_DIR", "/cache"))
CACHE_MAX_BYTES = int(os.environ.get("CACHE_MAX_SIZE_GB", "15")) * 1073741824
PREFETCH_BUFFER = int(os.environ.get("PREFETCH_BUFFER_MB", "30")) * 1048576
CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE_MB", "15")) * 1048576
PREFETCH_TIMEOUT = int(os.environ.get("PREFETCH_TIMEOUT_S", "90"))
INITIAL_CHUNKS = int(os.environ.get("INITIAL_CHUNKS", "1"))
STREAMER_PORT = int(os.environ.get("STREAMER_PORT", "8080"))

# Cache of resolved local file paths: part_id -> local absolute path
_local_file_paths: dict[int, str] = {}

# Pin the served variant ("original" | "compressed") for the duration of one
# playback so the reported file size never changes between a load and its seeks.
_serving_variant: dict[int, str] = {}


# Derived constants
PREFETCH_CHUNKS = PREFETCH_BUFFER // CHUNK_SIZE
DOWNLOAD_REQUEST_SIZE = 1048576  # 1 MB — Telethon iter_download piece size

MIME_MAP = {
    # video
    ".mp4": "video/mp4", ".webm": "video/webm", ".m4v": "video/mp4",
    ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo", ".flv": "video/x-flv",
    ".3gp": "video/3gpp", ".ts": "video/mp2t",
    # images
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".svg": "image/svg+xml", ".avif": "image/avif",
    # documents — correct Content-Type lets the browser preview them inline
    # (PDF in an <iframe>; text fetched as text; office files fetched as bytes
    # for client-side rendering via mammoth / SheetJS).
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8",
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip", ".rar": "application/vnd.rar",
    ".7z": "application/x-7z-compressed", ".gz": "application/gzip",
    ".tar": "application/x-tar",
}

# Video-only extensions — used to gate subtitle backfill so the now-expanded MIME_MAP
# (which also carries documents/images) doesn't make the STT loop pick up non-videos.
VIDEO_EXTS = {ext for ext, mime in MIME_MAP.items() if mime.startswith("video/")}

# ---------------------------------------------------------------------------
# Global state (initialised in lifespan)
# ---------------------------------------------------------------------------
tg_client: TelegramClient | None = None
db: PgClient | None = None
channel = None  # resolved Telegram channel entity

# Per-part-id asyncio locks to prevent duplicate chunk downloads
_part_locks: dict[tuple[int, int], asyncio.Lock] = defaultdict(asyncio.Lock)

# Per-video lock to prevent Telegram FloodWait from concurrent overlapping downloads
_tg_locks: dict[int, asyncio.Lock] = defaultdict(asyncio.Lock)
_tg_last_req_time: dict[int, float] = {}

# Telethon message cache: channel_msg_id → message object
_msg_cache: dict[int, object] = {}

# Track last-requested chunk index per part for prefetch orientation
_last_request_pos: dict[int, int] = {}

# Active prefetch tasks per part_id
_prefetch_tasks: dict[int, asyncio.Task] = {}

# Keep track of active main play requests per channel_msg_id to prevent prefetch contention
_active_downloads: dict[int, int] = defaultdict(int)

# Retroactive subtitle backfill bookkeeping
_backfill_task: "asyncio.Task | None" = None
_backfill_failed: set[int] = set()  # part_ids that failed THIS session (retried next restart)


# ---------------------------------------------------------------------------
# Helpers — disk cache
# ---------------------------------------------------------------------------
def _part_dir(part_id: int) -> Path:
    return CACHE_DIR / f"part_{part_id}"


def _meta_path(part_id: int) -> Path:
    return _part_dir(part_id) / "meta.json"


def _chunk_path(part_id: int, index: int) -> Path:
    return _part_dir(part_id) / f"chunk_{index:06d}"


def _read_meta(part_id: int) -> dict | None:
    p = _meta_path(part_id)
    if p.exists():
        return json.loads(p.read_text())
    return None


def _write_meta(meta: dict) -> None:
    d = _part_dir(meta["part_id"])
    d.mkdir(parents=True, exist_ok=True)
    _meta_path(meta["part_id"]).write_text(json.dumps(meta))


def _touch_meta(part_id: int) -> None:
    """Update last_accessed timestamp in meta.json."""
    meta = _read_meta(part_id)
    if meta:
        meta["last_accessed"] = time.time()
        _write_meta(meta)


def _mime_from_filename(name: str | None) -> str:
    if not name:
        return "video/mp4"
    ext = os.path.splitext(name)[1].lower()
    return MIME_MAP.get(ext, "video/mp4")


# ---------------------------------------------------------------------------
# Helpers — cache eviction (LRU by part directory)
# ---------------------------------------------------------------------------
def _cache_total_bytes() -> int:
    total = 0
    if not CACHE_DIR.exists():
        return 0
    for part_dir in CACHE_DIR.iterdir():
        if part_dir.is_dir() and part_dir.name.startswith("part_"):
            for f in part_dir.iterdir():
                if f.is_file():
                    total += f.stat().st_size
    return total


def _evict_if_needed(needed: int) -> None:
    """Evict oldest-accessed part directories until cache has room."""
    current = _cache_total_bytes()
    if current + needed <= CACHE_MAX_BYTES:
        return

    # Collect (last_accessed, part_dir) pairs
    entries: list[tuple[float, Path]] = []
    for part_dir in CACHE_DIR.iterdir():
        if not (part_dir.is_dir() and part_dir.name.startswith("part_")):
            continue
        meta_file = part_dir / "meta.json"
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text())
                entries.append((meta.get("last_accessed", 0), part_dir))
            except (json.JSONDecodeError, KeyError):
                entries.append((0, part_dir))
        else:
            entries.append((0, part_dir))

    # Sort oldest first
    entries.sort(key=lambda e: e[0])

    for _ts, part_dir in entries:
        if current + needed <= CACHE_MAX_BYTES:
            break
        dir_size = sum(f.stat().st_size for f in part_dir.iterdir() if f.is_file())
        log.info("Evicting cache dir %s (%.1f MB)", part_dir.name, dir_size / 1048576)
        shutil.rmtree(part_dir, ignore_errors=True)
        current -= dir_size


# ---------------------------------------------------------------------------
# Helpers — Local Bot API download & cache eviction
# ---------------------------------------------------------------------------
def _evict_local_api_cache_if_needed(needed_bytes: int) -> None:
    """Evict files from the local Bot API cache directory if disk usage exceeds the limit."""
    local_dir = Path("/var/lib/telegram-bot-api")
    if not local_dir.exists():
        return

    files = []
    total_size = 0
    for root, _, filenames in os.walk(local_dir):
        for name in filenames:
            file_path = Path(root) / name
            if file_path.is_file() and not file_path.name.endswith(".session"):
                try:
                    stat = file_path.stat()
                    files.append((stat.st_mtime, stat.st_size, file_path))
                    total_size += stat.st_size
                except Exception:
                    pass

    limit = CACHE_MAX_BYTES
    if total_size + needed_bytes <= limit:
        return

    log.info("Local Bot API cache size (%.1f MB) + needed (%.1f MB) exceeds limit (%.1f MB). Evicting...",
             total_size / 1048576, needed_bytes / 1048576, limit / 1048576)

    files.sort(key=lambda x: x[0])
    for _mtime, size, file_path in files:
        if total_size + needed_bytes <= limit:
            break
        log.info("Evicting local Bot API cached file: %s (%.1f MB)", file_path.name, size / 1048576)
        try:
            file_path.unlink()
            total_size -= size
        except Exception as e:
            log.error("Failed to delete local cache file %s: %s", file_path, e)

    for pid, path in list(_local_file_paths.items()):
        if not os.path.exists(path):
            _local_file_paths.pop(pid, None)


def _reclaim_original_after_compress(part_id: int, src_path: str) -> None:
    """Drop the now-redundant original from the Bot-API cache once a compressed copy exists.

    Fresh loads serve the compressed copy from here on, so the original is dead weight.
    On Linux an in-progress stream holding the file open keeps reading fine after unlink.
    """
    try:
        if src_path and os.path.exists(src_path):
            os.remove(src_path)
            log.info("Reclaimed original for part %d after compression: %s", part_id, src_path)
    except Exception as e:  # noqa: BLE001
        log.warning("Could not reclaim original for part %d: %s", part_id, e)
    _local_file_paths.pop(part_id, None)


async def download_via_local_bot_api(file_id: str) -> str:
    """Request the local Telegram Bot API server to download a file and return the absolute local file path."""
    if not TELEGRAM_API_URL or not BOT_TOKEN:
        raise ValueError("TELEGRAM_API_URL and BOT_TOKEN must be set to use local Bot API downloader")

    url = f"{TELEGRAM_API_URL}/bot{BOT_TOKEN}/getFile"
    log.info("Requesting local Bot API server to download file...")

    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(url, json={"file_id": file_id})
        if resp.status_code != 200:
            log.error("Telegram Bot API error response body: %s", resp.text)
        resp.raise_for_status()
        res = resp.json()
        if not res.get("ok"):
            raise ValueError(f"Telegram Bot API server error: {res}")

        file_path = res["result"]["file_path"]
        log.info("Local Bot API server download complete: %s", file_path)
        return file_path


async def resolve_file_id_via_forwarding(channel_msg_id: int, part_id: int) -> str:
    """
    Resolve a valid Bot API file_id by forwarding the channel message to the owner's chat,
    extracting the file_id, updating it in the database, and deleting the forwarded message.
    """
    if not TELEGRAM_API_URL or not BOT_TOKEN or not OWNER_USER_ID:
        raise ValueError("TELEGRAM_API_URL, BOT_TOKEN, and OWNER_USER_ID must be set")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # 1. Forward the message to the owner
        fwd_url = f"{TELEGRAM_API_URL}/bot{BOT_TOKEN}/forwardMessage"
        log.info(f"Forwarding channel_msg_id {channel_msg_id} to owner {OWNER_USER_ID} to resolve file_id...")
        fwd_resp = await client.post(fwd_url, json={
            "chat_id": OWNER_USER_ID,
            "from_chat_id": STORAGE_CHANNEL_ID,
            "message_id": channel_msg_id,
            "disable_notification": True
        })
        
        if fwd_resp.status_code != 200:
            log.error("Failed to forward message: %s", fwd_resp.text)
            fwd_resp.raise_for_status()
            
        fwd_data = fwd_resp.json()
        if not fwd_data.get("ok"):
            raise ValueError(f"Telegram Bot API forwardMessage error: {fwd_data}")
            
        fwd_msg = fwd_data["result"]
        fwd_msg_id = fwd_msg["message_id"]
        
        # 2. Extract file_id
        file_id = None
        if "document" in fwd_msg:
            file_id = fwd_msg["document"]["file_id"]
        elif "video" in fwd_msg:
            file_id = fwd_msg["video"]["file_id"]
        elif "animation" in fwd_msg:
            file_id = fwd_msg["animation"]["file_id"]
        elif "photo" in fwd_msg:
            file_id = fwd_msg["photo"][-1]["file_id"]
            
        if not file_id:
            # Delete message and raise
            try:
                del_url = f"{TELEGRAM_API_URL}/bot{BOT_TOKEN}/deleteMessage"
                await client.post(del_url, json={"chat_id": OWNER_USER_ID, "message_id": fwd_msg_id})
            except Exception:
                pass
            raise ValueError("Forwarded message does not contain a valid file (document, video, animation, or photo)")
            
        # 3. Update the database parts table
        log.info(f"Successfully resolved file_id. Updating parts table for part_id {part_id}...")
        try:
            await db.execute("UPDATE parts SET file_id = ? WHERE id = ?", [file_id, part_id])
        except Exception as e:
            log.error(f"Failed to update parts.file_id in database: {e}")
            
        # 4. Delete the forwarded message immediately (to clean up the user's chat)
        try:
            del_url = f"{TELEGRAM_API_URL}/bot{BOT_TOKEN}/deleteMessage"
            await client.post(del_url, json={"chat_id": OWNER_USER_ID, "message_id": fwd_msg_id})
            log.info("Deleted the temporary forwarded message from owner's chat")
        except Exception as e:
            log.warning(f"Failed to delete temporary forwarded message: {e}")
            
        return file_id




# ---------------------------------------------------------------------------
# Helpers — Telegram download
# ---------------------------------------------------------------------------
async def _get_tg_message(channel_msg_id: int):

    """Get a Telegram message, using the in-memory cache."""
    if channel_msg_id in _msg_cache:
        return _msg_cache[channel_msg_id]
    msg = await tg_client.get_messages(channel, ids=channel_msg_id)
    if msg:
        _msg_cache[channel_msg_id] = msg
    return msg


async def _ensure_chunk_stream(part_id: int, channel_msg_id: int, chunk_index: int, total_size: int, slice_start: int, slice_end: int, request=None):
    """
    Downloads/reads a chunk, saves it to disk, and yields bytes within [slice_start, slice_end].
    If slice_start >= slice_end, it just ensures the chunk is on disk without yielding.
    """
    if request and await request.is_disconnected():
        raise asyncio.CancelledError()

    chunk_path = CACHE_DIR / f"part_{part_id}" / f"chunk_{chunk_index:06d}"
    temp_path = chunk_path.with_suffix(".tmp")
    
    # 1. Read from disk if complete
    if chunk_path.exists():
        if slice_start < slice_end:
            with open(chunk_path, "rb") as f:
                if slice_start > 0:
                    f.seek(slice_start)
                remaining = slice_end - slice_start
                while remaining > 0:
                    piece = f.read(min(remaining, 65536))
                    if not piece:
                        break
                    yield piece
                    remaining -= len(piece)
        return

    # Wait if there is an active main download for this file (to avoid bandwidth/connection choking)
    if request is None:
        while _active_downloads.get(channel_msg_id, 0) > 0:
            await asyncio.sleep(0.2)

    # Increment active downloads immediately to notify prefetch tasks of main playback activity
    if request is not None:
        _active_downloads[channel_msg_id] += 1
        # Cancel any active prefetch task for this part and wait for it to release its locks
        existing = _prefetch_tasks.get(part_id)
        if existing and not existing.done():
            log.info("Main request cancelling active prefetch task for part %d to avoid lock contention", part_id)
            existing.cancel()
            try:
                await existing
            except asyncio.CancelledError:
                pass

    downloaded_so_far = 0
    # Determine the size of the chunk we expect
    if slice_start > 0 and slice_start < slice_end:
        byte_offset = chunk_index * CHUNK_SIZE + slice_start
        remaining_file = total_size - byte_offset
        chunk_bytes = min(slice_end - slice_start, remaining_file)
    else:
        byte_offset = chunk_index * CHUNK_SIZE
        remaining_file = total_size - byte_offset
        chunk_bytes = min(CHUNK_SIZE, remaining_file)

    try:
        # 2. Lock and download
        async with _part_locks[(part_id, chunk_index)]:
            # Double check
            if chunk_path.exists():
                if slice_start < slice_end:
                    with open(chunk_path, "rb") as f:
                        if slice_start > 0:
                            f.seek(slice_start)
                        remaining = slice_end - slice_start
                        while remaining > 0:
                            piece = f.read(min(remaining, 65536))
                            if not piece:
                                break
                            yield piece
                            remaining -= len(piece)
                return

            # Bypass cache if jumping into the middle of a chunk.
            # This prevents blocking the video player while we download the start of the chunk.
            if slice_start > 0 and slice_start < slice_end:
                msg = await _get_tg_message(channel_msg_id)
                if not msg or not msg.media:
                    raise ValueError(f"Message {channel_msg_id} has no media")

                for attempt in range(5):
                    try:
                        target_offset = byte_offset + downloaded_so_far
                        target_len = chunk_bytes - downloaded_so_far

                        if target_len <= 0:
                            return

                        # Telegram API requires offset and limit to be multiples of 4096 (4 KB) for large files,
                        # and requests must not cross 1 MB boundaries. To satisfy both, we align offset
                        # to DOWNLOAD_REQUEST_SIZE (512 KB), which is a multiple of 4096 and divides 1 MB.
                        aligned_offset = (target_offset // DOWNLOAD_REQUEST_SIZE) * DOWNLOAD_REQUEST_SIZE
                        skipped_bytes = target_offset - aligned_offset
                        aligned_limit = ((target_len + skipped_bytes + 4095) // 4096) * 4096

                        async with _tg_locks[channel_msg_id]:
                            import time
                            now = time.time()
                            last_req = _tg_last_req_time.get(channel_msg_id, 0)
                            sleep_time = 0.1 - (now - last_req)
                            if sleep_time > 0:
                                for _ in range(int(sleep_time * 10) + 1):
                                    if request and await request.is_disconnected():
                                        raise asyncio.CancelledError()
                                    await asyncio.sleep(0.1)
                            _tg_last_req_time[channel_msg_id] = time.time()

                            stream_pos = 0
                            async for piece in tg_client.iter_download(
                                msg.media, offset=aligned_offset,
                                request_size=DOWNLOAD_REQUEST_SIZE, limit=aligned_limit,
                            ):
                                piece_len = len(piece)
                                piece_start = stream_pos
                                piece_end = stream_pos + piece_len
                                stream_pos += piece_len

                                # We want the bytes in stream range [skipped_bytes, skipped_bytes + target_len]
                                overlap_start = max(skipped_bytes, piece_start)
                                overlap_end = min(skipped_bytes + target_len, piece_end)
                                if overlap_start < overlap_end:
                                    rel_start = overlap_start - piece_start
                                    rel_end = overlap_end - piece_start
                                    try:
                                        yield piece[rel_start:rel_end]
                                    except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
                                        log.info("Client disconnected during bypass, aborting part %d chunk %d", part_id, chunk_index)
                                        raise asyncio.CancelledError()
                                    downloaded_so_far += (overlap_end - overlap_start)
                                if downloaded_so_far >= chunk_bytes:
                                    break
                        return
                    except telethon.errors.FloodError as e:
                        wait_time = getattr(e, 'seconds', None)
                        if wait_time is None:
                            import re
                            match = re.search(r"WAIT_(\d+)", str(e))
                            wait_time = int(match.group(1)) if match else 5
                        log.warning("Telegram flood wait: %ds (attempt %d bypass). Sleeping...", wait_time, attempt + 1)
                        for _ in range(wait_time + 1):
                            if request and await request.is_disconnected():
                                raise asyncio.CancelledError()
                            await asyncio.sleep(1)
                    except Exception as e:
                        log.error("Telegram download error on bypass chunk %d: %s", chunk_index, e)
                        if attempt == 4:
                            raise
                        for _ in range(2):
                            if request and await request.is_disconnected():
                                raise asyncio.CancelledError()
                            await asyncio.sleep(1)
                raise RuntimeError(f"Failed to stream chunk {chunk_index} after 5 attempts")

            # Evict cache if needed
            _evict_if_needed(CHUNK_SIZE)

            msg = await _get_tg_message(channel_msg_id)
            if not msg or not msg.media:
                raise ValueError(f"Message {channel_msg_id} has no media")

            file_mode = "wb"

            for attempt in range(5):
                try:
                    with open(temp_path, file_mode) as f:
                        current_offset = byte_offset + downloaded_so_far
                        current_remaining = chunk_bytes - downloaded_so_far
                        if current_remaining <= 0:
                            break

                        # Align the limit up to the nearest multiple of 4096 for Telegram requirements.
                        # Since byte_offset is a multiple of CHUNK_SIZE (multiple of 4096),
                        # and downloaded_so_far is advanced in multiples of 512 KB,
                        # current_offset is always a multiple of 4096.
                        aligned_limit = ((current_remaining + 4095) // 4096) * 4096

                        async with _tg_locks[channel_msg_id]:
                            import time
                            now = time.time()
                            last_req = _tg_last_req_time.get(channel_msg_id, 0)
                            sleep_time = 0.1 - (now - last_req)
                            if sleep_time > 0:
                                for _ in range(int(sleep_time * 10) + 1):
                                    if request and await request.is_disconnected():
                                        raise asyncio.CancelledError()
                                    await asyncio.sleep(0.1)
                            _tg_last_req_time[channel_msg_id] = time.time()

                            stream_pos = downloaded_so_far
                            async for piece in tg_client.iter_download(
                                msg.media, offset=current_offset,
                                request_size=DOWNLOAD_REQUEST_SIZE, limit=aligned_limit,
                            ):
                                # Cooperative abort for prefetch tasks if a main download starts
                                if request is None and _active_downloads.get(channel_msg_id, 0) > 0:
                                    log.info("Aborting prefetch of part %d chunk %d because main download started", part_id, chunk_index)
                                    raise asyncio.CancelledError()

                                # We only write up to chunk_bytes to the file
                                write_len = min(len(piece), chunk_bytes - downloaded_so_far)
                                if write_len > 0:
                                    f.write(piece[:write_len])

                                piece_start = downloaded_so_far
                                piece_end = downloaded_so_far + len(piece)
                                downloaded_so_far += write_len

                                # Yield logic if requested
                                if slice_start < slice_end:
                                    overlap_start = max(slice_start, piece_start)
                                    overlap_end = min(slice_end, piece_start + write_len)
                                    if overlap_start < overlap_end:
                                        rel_start = overlap_start - piece_start
                                        rel_end = overlap_end - piece_start
                                        try:
                                            yield piece[rel_start:rel_end]
                                        except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
                                            log.info("Client disconnected during stream, aborting part %d chunk %d", part_id, chunk_index)
                                            raise asyncio.CancelledError()
                                if downloaded_so_far >= chunk_bytes:
                                    break

                    os.rename(temp_path, chunk_path)
                    return  # Success
                except telethon.errors.FloodError as e:
                    file_mode = "ab"  # append on retry
                    wait_time = getattr(e, 'seconds', None)
                    if wait_time is None:
                        import re
                        match = re.search(r"WAIT_(\d+)", str(e))
                        wait_time = int(match.group(1)) if match else 5
                    log.warning("Telegram flood wait: %ds (attempt %d). Sleeping...", wait_time, attempt + 1)
                    for _ in range(wait_time + 1):
                        if request and await request.is_disconnected():
                            raise asyncio.CancelledError()
                        await asyncio.sleep(1)
                except Exception as e:
                    file_mode = "ab"
                    log.error("Telegram download error on chunk %d: %s", chunk_index, e)
                    if attempt == 4:
                        raise
                    for _ in range(2):
                        if request and await request.is_disconnected():
                            raise asyncio.CancelledError()
                        await asyncio.sleep(1)
            raise RuntimeError(f"Failed to download chunk {chunk_index} after 5 attempts")
    finally:
        if request is not None:
            _active_downloads[channel_msg_id] -= 1
        
        # If the chunk was fully downloaded but we got cancelled before renaming, rename it now!
        if downloaded_so_far == chunk_bytes and slice_start == 0:
            if temp_path.exists() and not chunk_path.exists():
                try:
                    os.rename(temp_path, chunk_path)
                    log.info("Successfully promoted completed chunk %d of part %d to cache in finally block", chunk_index, part_id)
                except Exception as e:
                    log.error("Failed to rename temp file to cache in finally block: %s", e)


# ---------------------------------------------------------------------------
# Helpers — metadata initialisation
# ---------------------------------------------------------------------------
async def _init_part_meta(part_id: int) -> dict:
    """Query Turso for part info and create meta.json. Returns meta dict."""
    # Any non-deleted part is streamable — media (video/image) AND documents
    # (PDF/Word/Excel/…). Documents are downloaded & cached on demand exactly like
    # media; the inline preview in the web UI fetches them through this same route.
    rs = await db.execute(
        "SELECT p.id, p.channel_msg_id, p.file_size, p.file_name, p.file_id "
        "FROM parts p "
        "JOIN items i ON i.id = p.item_id "
        "WHERE p.id = ? "
        "AND i.deleted_at IS NULL",
        [part_id],
    )
    if not rs.rows:
        raise ValueError(f"Part {part_id} not found or not streamable")

    row = rs.rows[0]
    total_size = row[2]
    file_name = row[3]
    total_chunks = (total_size + CHUNK_SIZE - 1) // CHUNK_SIZE

    meta = {
        "part_id": int(row[0]),
        "channel_msg_id": int(row[1]),
        "total_size": int(total_size),
        "mime": _mime_from_filename(file_name),
        "chunk_size": CHUNK_SIZE,
        "total_chunks": total_chunks,
        "last_accessed": time.time(),
        "file_id": row[4] if row[4] else None,
    }
    _write_meta(meta)
    log.info("Initialised meta for part %d: %d bytes, %d chunks, %s",
             part_id, total_size, total_chunks, meta["mime"])
    return meta



# ---------------------------------------------------------------------------
# Prefetch manager
# ---------------------------------------------------------------------------
async def _prefetch_worker(part_id: int, channel_msg_id: int,
                           start_chunk: int, total_chunks: int,
                           total_size: int) -> None:
    """Background task: download chunks ahead of the play position."""
    try:
        idx = start_chunk
        while idx < total_chunks:
            # Check for inactivity/timeout if there are no active play requests
            if _active_downloads.get(channel_msg_id, 0) == 0:
                meta = _read_meta(part_id)
                if meta and (time.time() - meta.get("last_accessed", 0)) > 15:
                    log.info("Prefetch for part %d stopped — inactive for >15s", part_id)
                    return

            # Check if play position has moved far away (seek detection)
            current_pos = _last_request_pos.get(part_id, start_chunk)
            if abs(idx - current_pos) > PREFETCH_CHUNKS:
                log.info("Prefetch for part %d cancelled — seek detected", part_id)
                return

            # Stop if we've cached enough ahead
            cached_ahead = 0
            for probe in range(current_pos, min(current_pos + PREFETCH_CHUNKS, total_chunks)):
                if _chunk_path(part_id, probe).exists():
                    cached_ahead += 1
            if cached_ahead >= PREFETCH_CHUNKS:
                # Wait a bit and re-check — play position may advance
                await asyncio.sleep(1)
                # Check for timeout
                meta = _read_meta(part_id)
                if meta and (time.time() - meta.get("last_accessed", 0)) > PREFETCH_TIMEOUT:
                    log.info("Prefetch for part %d timed out", part_id)
                    return
                continue

            # Skip chunks already on disk
            if _chunk_path(part_id, idx).exists():
                idx += 1
                continue
            
            try:
                async with aclosing(_ensure_chunk_stream(part_id, channel_msg_id, idx, total_size, 0, 0)) as stream:
                    async for _ in stream:
                        pass
            except Exception as e:
                log.error("Prefetch error for part %d chunk %d: %s", part_id, idx, e)
            
            idx += 1
            # Yield to event loop
            await asyncio.sleep(0.05)

    except asyncio.CancelledError:
        log.info("Prefetch for part %d cancelled", part_id)
    except Exception:
        log.exception("Prefetch error for part %d", part_id)

def _cancel_other_prefetches(current_part_id: int) -> None:
    """Cancel all active prefetch tasks for any other part_id."""
    for pid, t in list(_prefetch_tasks.items()):
        if pid != current_part_id and not t.done():
            log.info("Cancelling active prefetch task for other part %d", pid)
            t.cancel()
            _prefetch_tasks.pop(pid, None)


def _start_prefetch(part_id: int, channel_msg_id: int,
                    from_chunk: int, total_chunks: int,
                    total_size: int) -> None:
    """Start or restart prefetch for a part, cancelling any existing task."""
    existing = _prefetch_tasks.get(part_id)
    if existing and not existing.done():
        existing.cancel()

    task = asyncio.create_task(
        _prefetch_worker(part_id, channel_msg_id,
                         from_chunk, total_chunks, total_size)
    )
    _prefetch_tasks[part_id] = task


# ---------------------------------------------------------------------------
# Retroactive subtitle backfill — slowly subtitle already-indexed videos
# ---------------------------------------------------------------------------
async def _fetch_part_row(part_id: int) -> dict | None:
    """Look up one part's download metadata; returns None if it's gone or not a video file."""
    rs = await db.execute(
        "SELECT p.id, p.channel_msg_id, p.file_name, p.file_id "
        "FROM parts p JOIN items i ON i.id = p.item_id "
        "WHERE p.id = ? AND i.deleted_at IS NULL",
        [part_id],
    )
    for row in rs.rows:
        ext = os.path.splitext(row[2] or "")[1].lower()
        if ext not in VIDEO_EXTS:
            return None
        return {
            "part_id": int(row[0]),
            "channel_msg_id": int(row[1]),
            "file_name": row[2] or "",
            "file_id": row[3],
        }
    return None


async def _next_backfill_part() -> dict | None:
    """Pick the next part to subtitle. Repairs incomplete (`.partial`) videos first — re-running
    only their missing chunks — then falls back to videos with no subtitles at all. Both skip
    this-session failures (retried next restart)."""
    # 1. Repair pass: resume any video left incomplete by an earlier partial-chunk failure.
    for part_id in partial_part_ids():
        if part_id in _backfill_failed or is_subtitled_done(part_id):
            continue
        part = await _fetch_part_row(part_id)
        if part:
            return part
    # 2. Fresh pass: an indexed video with no subtitles yet.
    rs = await db.execute(
        "SELECT p.id, p.channel_msg_id, p.file_name, p.file_id "
        "FROM parts p JOIN items i ON i.id = p.item_id "
        "WHERE i.kind = 'media' AND i.deleted_at IS NULL "
        "AND p.id NOT IN (SELECT part_id FROM subtitles) "
        "ORDER BY p.id"
    )
    for row in rs.rows:
        part_id = int(row[0])
        if part_id in _backfill_failed:
            continue
        ext = os.path.splitext(row[2] or "")[1].lower()
        if ext not in MIME_MAP:  # only real video files
            continue
        if is_subtitled_done(part_id):  # e.g. processed but no-speech (.done, no rows)
            continue
        return {
            "part_id": part_id,
            "channel_msg_id": int(row[1]),
            "file_name": row[2] or "",
            "file_id": row[3],
        }
    return None


async def _backfill_one(part: dict) -> None:
    """Download one video, generate its subtitles, then delete the download to reclaim disk."""
    part_id = part["part_id"]
    channel_msg_id = part["channel_msg_id"]
    file_id = part.get("file_id")
    path: str | None = None

    async with _part_locks[(part_id, -1)]:
        if not file_id:
            try:
                file_id = await resolve_file_id_via_forwarding(channel_msg_id, part_id)
            except Exception as e:  # noqa: BLE001
                log.warning("Backfill: cannot resolve file_id for part %d: %s", part_id, e)
                _backfill_failed.add(part_id)
                return
        _evict_local_api_cache_if_needed(0)
        try:
            path = await download_via_local_bot_api(file_id)
        except Exception as e:  # noqa: BLE001
            log.warning("Backfill: download failed for part %d (%s) — retrying with fresh file_id", part_id, e)
            try:
                file_id = await resolve_file_id_via_forwarding(channel_msg_id, part_id)
                path = await download_via_local_bot_api(file_id)
            except Exception as e2:  # noqa: BLE001
                log.warning("Backfill: download failed for part %d: %s", part_id, e2)
                _backfill_failed.add(part_id)
                return

    try:
        await run_subtitle_job(db, part_id, path)
        # The worker writes the `.done` marker only when a part is finalised (complete,
        # no-speech, no-audio, or budget-exhausted). If it's still absent the part either
        # fully failed or made PARTIAL progress (some chunks cached, a `.partial` marker
        # left). Either way don't re-attempt it again THIS session — that avoids rapid
        # re-downloads; it resumes (from its cached chunks) on the next restart/rescan.
        if not is_subtitled_done(part_id):
            _backfill_failed.add(part_id)
            if is_subtitle_partial(part_id):
                log.info(
                    "Backfill: part %d partial — successful chunks cached; the missing "
                    "ones are repaired on the next pass", part_id,
                )
            else:
                log.warning(
                    "Backfill: part %d produced no subtitles (transcription failed) — "
                    "skipping for this session", part_id,
                )
    finally:
        # Subtitle-only backfill: drop the downloaded original once subs are written.
        try:
            if path and os.path.exists(path):
                os.remove(path)
        except Exception:  # noqa: BLE001
            pass
        _local_file_paths.pop(part_id, None)


async def _subtitle_backfill_loop() -> None:
    """Slowly subtitle already-indexed videos, one at a time, paced to respect API limits."""
    if not (SUBTITLE_BACKFILL and SUBTITLE_GEN and stt_available()):
        return
    await asyncio.sleep(SUBTITLE_BACKFILL_START_DELAY_S)
    # First, a one-time download-free pass that repairs any video whose translations failed
    # under the old logic (re-translates straight from the on-disk original VTT).
    try:
        await repair_translations_on_disk(db)
    except Exception:  # noqa: BLE001
        log.exception("Translation repair pass failed")
    pace = f"one every {SUBTITLE_BACKFILL_INTERVAL_S}s" if SUBTITLE_BACKFILL_INTERVAL_S > 0 else "back-to-back"
    log.info("Subtitle backfill enabled — %s", pace)
    while True:
        try:
            part = await _next_backfill_part()
            if part is None:
                # Nothing fresh and no eligible partials right now. Before the idle nap,
                # forget this-session failures for INCOMPLETE (.partial) videos so the next
                # rescan re-attempts their missing chunks (the worker's attempt budget still
                # caps total tries). Fully-failed parts stay skipped until the next restart.
                for pid in partial_part_ids():
                    _backfill_failed.discard(pid)
                # Also retry any translation-repair that's still incomplete (a Google throttle
                # left a target language missing) — self-heals without needing a restart.
                try:
                    await repair_translations_on_disk(db)
                except Exception:  # noqa: BLE001
                    log.exception("Translation repair (idle) failed")
                await asyncio.sleep(SUBTITLE_BACKFILL_IDLE_S)
                continue
            log.info("Subtitle backfill: processing part %d (%s)", part["part_id"], part["file_name"])
            await _backfill_one(part)
        except asyncio.CancelledError:
            break
        except Exception:  # noqa: BLE001
            log.exception("Subtitle backfill loop error")
        # Optional extra pace between videos (0 = none; 3 Groq keys absorb rate limits).
        if SUBTITLE_BACKFILL_INTERVAL_S > 0:
            await asyncio.sleep(SUBTITLE_BACKFILL_INTERVAL_S)


# ---------------------------------------------------------------------------
# FastAPI lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_app: FastAPI):
    global tg_client, db, channel, _backfill_task

    init_semaphore()  # create the transcode concurrency semaphore in the running loop
    init_subtitle_semaphore()  # create the subtitle concurrency semaphore in the running loop
    init_seekpreview_semaphore()  # create the seek-preview concurrency semaphore

    log.info("Starting streamer — connecting to Telegram and Turso…")
    tg_client = TelegramClient(SESSION, API_ID, API_HASH)
    await tg_client.connect()
    if not await tg_client.is_user_authorized():
        log.error("Telethon session not authorised. Run login.py first.")
        raise RuntimeError("Telethon session not authorised")

    channel = await tg_client.get_entity(STORAGE_CHANNEL_ID)
    log.info("Telegram connected — channel resolved")

    db = create_client()
    log.info("PostgreSQL client ready")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if VIDEO_COMPRESS:
        try:
            COMPRESSED_DIR.mkdir(parents=True, exist_ok=True)
            log.info("Video compression enabled → persistent dir %s (CRF %s/%s)",
                     COMPRESSED_DIR, VIDEO_CRF, VIDEO_PRESET)
        except Exception as e:  # noqa: BLE001
            log.warning("Could not create compressed dir %s: %s", COMPRESSED_DIR, e)
    if SUBTITLE_GEN:
        try:
            SUBTITLES_DIR.mkdir(parents=True, exist_ok=True)
            log.info("Subtitle generation enabled → persistent dir %s (%d Groq key(s))",
                     SUBTITLES_DIR, len(GROQ_API_KEYS))
            if not GROQ_API_KEYS:
                log.warning("SUBTITLE_GEN on but GROQ_API_KEYS is empty — no subtitles will be made")
        except Exception as e:  # noqa: BLE001
            log.warning("Could not create subtitles dir %s: %s", SUBTITLES_DIR, e)
    try:
        SEEKPREVIEW_DIR.mkdir(parents=True, exist_ok=True)
        log.info("Seek preview dir ready → %s", SEEKPREVIEW_DIR)
    except Exception as e:  # noqa: BLE001
        log.warning("Could not create seek-preview dir %s: %s", SEEKPREVIEW_DIR, e)

    # Kick off the slow retroactive subtitle backfill (one already-indexed video at a time).
    if SUBTITLE_BACKFILL and SUBTITLE_GEN and GROQ_API_KEYS:
        _backfill_task = asyncio.create_task(_subtitle_backfill_loop())

    yield  # --- app runs ---

    # Shutdown
    log.info("Shutting down streamer…")
    if _backfill_task:
        _backfill_task.cancel()
    for task in _prefetch_tasks.values():
        task.cancel()
    if db:
        await db.close()
    if tg_client:
        await tg_client.disconnect()
    log.info("Streamer stopped")


app = FastAPI(title="Telegram Cloud Drive Streamer", lifespan=lifespan)


# Optional shared-secret guard. When the streamer is reachable from the public internet (e.g. via a
# Cloudflare Tunnel so a Vercel-hosted dashboard can stream from it), set STREAMER_SECRET so only the
# dashboard — which forwards it as X-Streamer-Secret — can use it. Empty = no check (internal-only;
# the streamer is only on the Docker network). /health is always open for connectivity checks.
STREAMER_SECRET = os.environ.get("STREAMER_SECRET", "").strip()


@app.middleware("http")
async def _require_secret(request: Request, call_next):
    if STREAMER_SECRET and request.url.path != "/health":
        if request.headers.get("x-streamer-secret") != STREAMER_SECRET:
            return Response(status_code=403, content="Forbidden")
    return await call_next(request)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {"status": "ok", "time": time.time()}


@app.get("/logs")
async def get_logs():
    return {"logs": list(mem_handler.buffer)}


@app.get("/tasks")
async def get_tasks():
    import traceback
    info = []
    for t in asyncio.all_tasks():
        stack = []
        for frame in t.get_stack():
            stack.append(f"{frame.f_code.co_filename}:{frame.f_lineno} in {frame.f_code.co_name}")
        info.append({
            "name": t.get_name(),
            "coro": str(t.get_coro()),
            "stack": stack,
            "cancelled": t.cancelled(),
            "done": t.done()
        })
    return {"tasks": info}


@app.get("/subtitles/{part_id}")
async def list_subtitles(part_id: int):
    """List the subtitle languages available on disk for a part."""
    return {"part_id": part_id, "langs": available_langs(part_id)}


@app.get("/subtitles/{part_id}/{lang}")
async def get_subtitle(part_id: int, lang: str):
    """Serve a WebVTT subtitle track. `lang` is validated against what's on disk."""
    if lang not in available_langs(part_id):
        return Response("Not found", status_code=404)
    p = subtitle_path(part_id, lang)
    if not p.exists():
        return Response("Not found", status_code=404)
    return Response(
        p.read_text(encoding="utf-8"),
        media_type="text/vtt",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# Active seek-preview generation tasks (fire-and-forget, dedup'd by part_id)
_seekpreview_tasks: dict[int, asyncio.Task] = {}


def _schedule_seekpreview(part_id: int, src_path: str) -> asyncio.Task | None:
    """Fire-and-forget: generate seek-preview sprites if not already done.
    Returns the running Task, or None if it's already done.
    """
    if has_preview(part_id):
        return None
    existing = _seekpreview_tasks.get(part_id)
    if existing and not existing.done():
        return existing

    async def _run():
        try:
            await generate_seek_preview(part_id, src_path)
        except Exception:  # noqa: BLE001
            log.exception("Seek preview generation failed for part %d", part_id)
        finally:
            _seekpreview_tasks.pop(part_id, None)

    task = asyncio.create_task(_run())
    _seekpreview_tasks[part_id] = task
    return task


@app.get("/seek-preview/{part_id}")
async def serve_seekpreview_vtt(part_id: int, wait: bool = False):
    """Serve the generated WebVTT file for Plyr previewThumbnails.
    If wait=True, blocks up to 60s for the background generation to finish.
    """
    if wait and not has_preview(part_id):
        # Wait up to 60 seconds
        for _ in range(60):
            if has_preview(part_id):
                break
            task = _seekpreview_tasks.get(part_id)
            if task and not task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
                except Exception:
                    break
            else:
                await asyncio.sleep(1)

    if not has_preview(part_id):
        raise HTTPException(status_code=404, detail="Seek preview not ready")

    p = seekpreview_vtt_path(part_id)
    if not p.exists():
        return Response("Not found", status_code=404)
    return Response(
        p.read_text(encoding="utf-8"),
        media_type="text/vtt",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/seek-preview/{part_id}/sprite")
async def get_seek_preview_sprite(part_id: int):
    """Serve the sprite-sheet JPEG for seek-preview thumbnails."""
    sp = seekpreview_sprite_path(part_id)
    if not sp.exists():
        return Response("Not found", status_code=404)
    return Response(
        sp.read_bytes(),
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/stream/{part_id}")
async def stream(part_id: int, request: Request):
    """Serve video chunks with HTTP 206 Partial Content."""
    _cancel_other_prefetches(part_id)

    # Cancel any active prefetch task for the current part to avoid lock contention
    existing = _prefetch_tasks.get(part_id)
    if existing and not existing.done():
        log.info("Cancelling active prefetch for part %d due to new stream request", part_id)
        existing.cancel()
        try:
            await existing
        except asyncio.CancelledError:
            pass

    # --- 1. Check & Init Metadata ---
    meta = _read_meta(part_id)
    if meta and meta.get("chunk_size") != CHUNK_SIZE:
        log.warning("Chunk size changed (was %s, now %d), evicting cache for part %d", 
                    meta.get("chunk_size"), CHUNK_SIZE, part_id)
        shutil.rmtree(CACHE_DIR / f"part_{part_id}", ignore_errors=True)
        meta = None

    if meta is None:
        try:
            meta = await _init_part_meta(part_id)
        except ValueError as exc:
            return Response(str(exc), status_code=404)

    total_size = meta["total_size"]
    channel_msg_id = meta["channel_msg_id"]
    total_chunks = meta["total_chunks"]
    mime = meta["mime"]

    # Touch last_accessed
    _touch_meta(part_id)

    # --- 2. Parse Range header ---
    range_header = request.headers.get("range")
    if not range_header:
        # No range → serve first chunk and indicate range support
        start = 0
        end = min(CHUNK_SIZE, total_size) - 1
    else:
        # Parse "bytes=start-" or "bytes=start-end" or "bytes=-end"
        range_spec = range_header.replace("bytes=", "").strip()
        parts = range_spec.split("-", 1)
        try:
            if parts[0] == "":
                # bytes=-N (last N bytes)
                start = max(0, total_size - int(parts[1]))
                end = total_size - 1
            else:
                start = int(parts[0])
                if len(parts) > 1 and parts[1]:
                    end = min(int(parts[1]), total_size - 1)
                else:
                    # If no end byte, stream up to the end of the file.
                    # This allows Chrome to keep a single connection open instead of 
                    # rapidly reconnecting every 15MB, which prevents FloodWait.
                    end = total_size - 1
        except ValueError:
            # Fallback if range is completely malformed
            start = 0
            end = min(CHUNK_SIZE, total_size) - 1

    # Clamp
    start = max(0, start)
    end = min(end, total_size - 1)

    # --- 3. Local Bot API Mode (High-speed Direct Stream) ---
    if TELEGRAM_API_URL:
        # Pick the variant to serve. A fresh load (no Range / start==0) re-evaluates and
        # prefers the compressed copy once it exists; an in-progress load's seeks (start>0)
        # reuse the pinned variant so the reported file size never changes mid-session.
        comp_path = _compressed_path(part_id)
        is_fresh = (range_header is None) or (start == 0)
        if is_fresh:
            use_compressed = comp_path.exists()
            _serving_variant[part_id] = "compressed" if use_compressed else "original"
        else:
            use_compressed = (
                _serving_variant.get(part_id, "original") == "compressed" and comp_path.exists()
            )

        if use_compressed:
            _touch_meta(part_id)
            return _serve_local_file_range(str(comp_path), "video/mp4", request, range_header)

        # Serve the ORIGINAL (and trigger a background transcode for future views).
        # Try to use the file_id from the metadata (retrieved from parts.file_id in database)
        file_id = meta.get("file_id")
        if not file_id:
            try:
                # Not in DB yet (old file) -> resolve dynamically via forwarding
                file_id = await resolve_file_id_via_forwarding(channel_msg_id, part_id)
                meta["file_id"] = file_id  # update in memory meta
            except Exception as e:
                log.warning("Failed to resolve file_id via forwarding: %s. Falling back to Telethon pack_bot_file_id...", e)
                # Fallback to Telethon's pack_bot_file_id
                msg = await _get_tg_message(channel_msg_id)
                if not msg or not msg.media:
                    return Response("Message has no media", status_code=404)
                file_id = pack_bot_file_id(msg.media)
                if not file_id:
                    return Response("Failed to pack file ID", status_code=500)

        # Get local file path (download via Bot API server if needed)
        async with _part_locks[(part_id, -1)]:
            file_path = _local_file_paths.get(part_id)
            if not file_path or not os.path.exists(file_path):
                _evict_local_api_cache_if_needed(total_size)
                try:
                    file_path = await download_via_local_bot_api(file_id)
                    _local_file_paths[part_id] = file_path
                except Exception as e:
                    # In case the file_id was invalid/expired, try a fresh resolution via forwarding
                    log.warning("Local Bot API download failed: %s. Retrying with fresh resolved file_id...", e)
                    try:
                        file_id = await resolve_file_id_via_forwarding(channel_msg_id, part_id)
                        meta["file_id"] = file_id
                        file_path = await download_via_local_bot_api(file_id)
                        _local_file_paths[part_id] = file_path
                    except Exception as retry_err:
                        log.error("Failed to download even after dynamic re-resolution: %s", retry_err)
                        return Response(f"Failed to download file: {retry_err}", status_code=500)

        # First generate seek-preview sprites, THEN kick off background compression.
        # This gives the user immediate UI feedback and prevents two ffmpegs
        # from fighting for CPU at the exact same time.
        # Videos only — documents/images must never be fed to ffmpeg.
        if mime.startswith("video/"):
            sp_task = _schedule_seekpreview(part_id, file_path)

            async def _wait_and_transcode() -> None:
                if sp_task:
                    try:
                        await sp_task
                    except Exception:
                        pass
                _schedule_transcode(part_id, file_path, on_success=_reclaim_original_after_compress)

            asyncio.create_task(_wait_and_transcode())

        # NOTE: subtitle generation is intentionally NOT triggered here on first view.
        # It is driven purely by subtitle ABSENCE via the background backfill loop
        # (_subtitle_backfill_loop), which subtitles any indexed video that has no
        # subtitles yet — independent of whether it's ever watched. Keeping it off the
        # streaming path means playback never competes with STT for the shared semaphore.

        return _serve_local_file_range(file_path, mime, request, range_header)

    # --- 4. Fallback Telethon Mode (Sparse Chunk Cache) ---
    first_chunk = start // CHUNK_SIZE
    last_chunk = end // CHUNK_SIZE

    # Update play position for prefetch
    _last_request_pos[part_id] = first_chunk

    # Return StreamingResponse to send headers immediately and yield bytes
    async def byte_generator():
        try:
            for ci in range(first_chunk, last_chunk + 1):
                chunk_start_byte = ci * CHUNK_SIZE
                slice_start = max(start - chunk_start_byte, 0)
                slice_end = min(end - chunk_start_byte + 1, CHUNK_SIZE)
                
                async with aclosing(_ensure_chunk_stream(part_id, channel_msg_id, ci, total_size, slice_start, slice_end, request)) as stream:
                    async for chunk_data in stream:
                        yield chunk_data

            # Start prefetch only after successfully yielding all requested chunks
            prefetch_from = last_chunk + 1
            if prefetch_from < total_chunks:
                _start_prefetch(part_id, channel_msg_id,
                                prefetch_from, total_chunks, total_size)
        except asyncio.CancelledError:
            # Client disconnected, stop generating
            raise
        except Exception as e:
            log.error("Error generating chunk: %s", e)

    content_length = end - start + 1

    # Build 206 response
    return StreamingResponse(
        byte_generator(),
        status_code=206,
        headers={
            "Content-Range": f"bytes {start}-{end}/{total_size}",
            "Content-Length": str(content_length),
            "Accept-Ranges": "bytes",
            "Content-Type": mime,
            "Cache-Control": "no-cache",
        },
        media_type=mime,
    )



# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=STREAMER_PORT, log_level="info")
