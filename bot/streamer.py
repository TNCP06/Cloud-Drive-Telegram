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
import libsql_client
import uvicorn
import telethon.errors
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse
from telethon import TelegramClient
from telethon.utils import pack_bot_file_id

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
SESSION = os.environ.get("STREAMER_SESSION", "streamer")
BOT_TOKEN = os.environ.get("BOT_TOKEN")
TELEGRAM_API_URL = os.environ.get("TELEGRAM_API_URL")

TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")


def _turso_http_url(url: str) -> str:
    """Transform libsql:// URL to https:// for Hrana-over-HTTP transport."""
    if url.startswith("libsql://"):
        return "https://" + url[len("libsql://"):]
    return url


TURSO_DATABASE_URL = _turso_http_url(os.environ["TURSO_DATABASE_URL"])

CACHE_DIR = Path(os.environ.get("CACHE_DIR", "/cache"))
CACHE_MAX_BYTES = int(os.environ.get("CACHE_MAX_SIZE_GB", "15")) * 1073741824
PREFETCH_BUFFER = int(os.environ.get("PREFETCH_BUFFER_MB", "30")) * 1048576
CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE_MB", "15")) * 1048576
PREFETCH_TIMEOUT = int(os.environ.get("PREFETCH_TIMEOUT_S", "90"))
INITIAL_CHUNKS = int(os.environ.get("INITIAL_CHUNKS", "1"))
STREAMER_PORT = int(os.environ.get("STREAMER_PORT", "8080"))

# Cache of resolved local file paths: part_id -> local absolute path
_local_file_paths: dict[int, str] = {}


# Derived constants
PREFETCH_CHUNKS = PREFETCH_BUFFER // CHUNK_SIZE
DOWNLOAD_REQUEST_SIZE = 1048576  # 1 MB — Telethon iter_download piece size

MIME_MAP = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".m4v": "video/mp4",
    ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo", ".flv": "video/x-flv",
    ".3gp": "video/3gpp", ".ts": "video/mp2t",
}

# ---------------------------------------------------------------------------
# Global state (initialised in lifespan)
# ---------------------------------------------------------------------------
tg_client: TelegramClient | None = None
db: libsql_client.Client | None = None
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


async def download_via_local_bot_api(file_id: str) -> str:
    """Request the local Telegram Bot API server to download a file and return the absolute local file path."""
    if not TELEGRAM_API_URL or not BOT_TOKEN:
        raise ValueError("TELEGRAM_API_URL and BOT_TOKEN must be set to use local Bot API downloader")

    url = f"{TELEGRAM_API_URL}/bot{BOT_TOKEN}/getFile"
    log.info("Requesting local Bot API server to download file...")

    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(url, json={"file_id": file_id})
        resp.raise_for_status()
        res = resp.json()
        if not res.get("ok"):
            raise ValueError(f"Telegram Bot API server error: {res}")

        file_path = res["result"]["file_path"]
        log.info("Local Bot API server download complete: %s", file_path)
        return file_path


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
    rs = await db.execute(
        "SELECT p.id, p.channel_msg_id, p.file_size, p.file_name "
        "FROM parts p "
        "JOIN items i ON i.id = p.item_id "
        "WHERE p.id = ? AND i.kind = 'media' AND i.total_parts = 1 "
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
# FastAPI lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_app: FastAPI):
    global tg_client, db, channel

    log.info("Starting streamer — connecting to Telegram and Turso…")
    tg_client = TelegramClient(SESSION, API_ID, API_HASH)
    await tg_client.connect()
    if not await tg_client.is_user_authorized():
        log.error("Telethon session not authorised. Run login.py first.")
        raise RuntimeError("Telethon session not authorised")

    channel = await tg_client.get_entity(STORAGE_CHANNEL_ID)
    log.info("Telegram connected — channel resolved")

    db = libsql_client.create_client(
        url=TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN,
    )
    log.info("Turso client ready")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    yield  # --- app runs ---

    # Shutdown
    log.info("Shutting down streamer…")
    for task in _prefetch_tasks.values():
        task.cancel()
    if db:
        await db.close()
    if tg_client:
        await tg_client.disconnect()
    log.info("Streamer stopped")


app = FastAPI(title="Telegram Cloud Drive Streamer", lifespan=lifespan)


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
        # Resolve Bot API file_id from Telethon message
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
                    log.error("Failed to download via local Bot API: %s", e)
                    return Response(f"Failed to download file: {e}", status_code=500)

        # Generate stream from local file
        async def local_file_generator():
            try:
                if os.path.exists(file_path):
                    os.utime(file_path, None)  # mark as accessed
                
                with open(file_path, "rb") as f:
                    f.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        if await request.is_disconnected():
                            break
                        chunk = f.read(min(remaining, 1024 * 1024))
                        if not chunk:
                            break
                        yield chunk
                        remaining -= len(chunk)
            except Exception as e:
                log.error("Error streaming local file: %s", e)

        content_length = end - start + 1
        return StreamingResponse(
            local_file_generator(),
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
