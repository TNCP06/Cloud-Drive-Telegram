"""Background video compression for the streamer (Local Bot API mode).

The original is served from the evictable Bot API cache (instant first view); in the
background ffmpeg transcodes a smaller, browser-playable H.264 copy into COMPRESSED_DIR
(a PERSISTENT volume). Later views serve the compressed copy → less VPS bandwidth, same
visual quality. Also hosts the local-file byte-range serving helper used for both variants.
"""

import asyncio
import logging
import os
from pathlib import Path

from fastapi import Request
from fastapi.responses import StreamingResponse

log = logging.getLogger("streamer")

COMPRESSED_DIR = Path(os.environ.get("COMPRESSED_DIR", "/compressed"))
VIDEO_COMPRESS = os.environ.get("VIDEO_COMPRESS", "1") not in ("0", "false", "False", "")
VIDEO_CRF = os.environ.get("VIDEO_CRF", "23")              # 18=near-lossless … 28=smaller
VIDEO_PRESET = os.environ.get("VIDEO_PRESET", "medium")    # ffmpeg x264 preset (speed/size)
VIDEO_MIN_COMPRESS_BYTES = int(os.environ.get("VIDEO_MIN_COMPRESS_MB", "20")) * 1048576
VIDEO_TRANSCODE_CONCURRENCY = int(os.environ.get("VIDEO_TRANSCODE_CONCURRENCY", "1"))
# 0 = keep compressed copies forever (persistent). >0 = LRU-cap the compressed dir.
COMPRESSED_MAX_BYTES = int(os.environ.get("COMPRESSED_MAX_SIZE_GB", "0")) * 1073741824

# Background transcode bookkeeping
_transcoding: set[int] = set()
_transcode_sem: "asyncio.Semaphore | None" = None  # created in lifespan (needs a running loop)


def init_semaphore() -> None:
    """Create the concurrency semaphore inside the running event loop (call from lifespan)."""
    global _transcode_sem
    _transcode_sem = asyncio.Semaphore(max(1, VIDEO_TRANSCODE_CONCURRENCY))


def _compressed_path(part_id: int) -> Path:
    return COMPRESSED_DIR / f"part_{part_id}.mp4"


def _compressed_skip_path(part_id: int) -> Path:
    # Marker: transcoding this part gave no worthwhile size gain → don't retry.
    return COMPRESSED_DIR / f"part_{part_id}.skip"


def _safe_unlink(p: Path) -> None:
    try:
        if p.exists():
            p.unlink()
    except Exception:  # noqa: BLE001
        pass


def _parse_range(range_header: str | None, size: int) -> tuple[int, int]:
    """Parse an HTTP Range header against a known file size → (start, end) inclusive."""
    if not range_header:
        return 0, max(0, size - 1)
    spec = range_header.replace("bytes=", "").strip()
    bits = spec.split("-", 1)
    try:
        if bits[0] == "":
            start = max(0, size - int(bits[1]))
            end = size - 1
        else:
            start = int(bits[0])
            end = min(int(bits[1]), size - 1) if len(bits) > 1 and bits[1] else size - 1
    except ValueError:
        start, end = 0, size - 1
    start = max(0, start)
    end = min(end, size - 1)
    return start, end


def _serve_local_file_range(path: str, mime: str, request: Request, range_header: str | None) -> StreamingResponse:
    """Stream a byte range of a local file as 206 Partial Content."""
    size = os.path.getsize(path)
    start, end = _parse_range(range_header, size)

    async def gen():
        try:
            os.utime(path, None)  # mark accessed (for LRU on the original cache)
        except Exception:  # noqa: BLE001
            pass
        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    if await request.is_disconnected():
                        break
                    chunk = f.read(min(remaining, 1048576))
                    if not chunk:
                        break
                    yield chunk
                    remaining -= len(chunk)
        except Exception as e:  # noqa: BLE001
            log.error("Error streaming local file %s: %s", path, e)

    return StreamingResponse(
        gen(),
        status_code=206,
        headers={
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(end - start + 1),
            "Accept-Ranges": "bytes",
            "Content-Type": mime,
            "Cache-Control": "no-cache",
        },
        media_type=mime,
    )


def _evict_compressed_if_needed() -> None:
    """Optional LRU cap on the (otherwise persistent) compressed dir. No-op if unlimited."""
    if COMPRESSED_MAX_BYTES <= 0 or not COMPRESSED_DIR.exists():
        return
    files = [f for f in COMPRESSED_DIR.glob("part_*.mp4") if f.is_file()]
    total = sum(f.stat().st_size for f in files)
    if total <= COMPRESSED_MAX_BYTES:
        return
    files.sort(key=lambda f: f.stat().st_mtime)  # oldest accessed first
    for f in files:
        if total <= COMPRESSED_MAX_BYTES:
            break
        sz = f.stat().st_size
        log.info("Evicting compressed file %s (%.1f MB)", f.name, sz / 1048576)
        _safe_unlink(f)
        total -= sz


async def _transcode_worker(part_id: int, src_path: str) -> None:
    """Transcode the original to a smaller browser-playable H.264 MP4 (persistent).

    Same resolution (no quality downscale) — the size win comes from efficient
    re-encoding. If the result isn't meaningfully smaller, drop it and leave a
    `.skip` marker so we keep serving the original and don't waste CPU retrying.
    """
    out_final = _compressed_path(part_id)
    out_tmp = Path(str(out_final) + ".tmp")
    skip = _compressed_skip_path(part_id)
    if out_final.exists() or skip.exists() or part_id in _transcoding:
        return
    _transcoding.add(part_id)
    try:
        async with _transcode_sem:  # cap concurrent (CPU-heavy) transcodes
            if out_final.exists() or skip.exists() or not os.path.exists(src_path):
                return
            src_size = os.path.getsize(src_path)
            if src_size < VIDEO_MIN_COMPRESS_BYTES:
                return  # too small to bother
            COMPRESSED_DIR.mkdir(parents=True, exist_ok=True)
            _safe_unlink(out_tmp)
            log.info("Transcoding part %d (%.1f MB) → H.264 CRF %s/%s …",
                     part_id, src_size / 1048576, VIDEO_CRF, VIDEO_PRESET)
            cmd = [
                "ffmpeg", "-y", "-i", src_path,
                "-c:v", "libx264", "-crf", str(VIDEO_CRF), "-preset", VIDEO_PRESET,
                "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
                str(out_tmp),
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                tail = stderr[-500:].decode("utf-8", "ignore") if stderr else ""
                log.error("ffmpeg failed for part %d (rc=%s): %s", part_id, proc.returncode, tail)
                _safe_unlink(out_tmp)
                return
            out_size = os.path.getsize(out_tmp) if out_tmp.exists() else 0
            if out_size == 0:
                _safe_unlink(out_tmp)
                return
            if out_size < src_size * 0.95:
                os.replace(out_tmp, out_final)
                log.info("Compressed part %d: %.1f → %.1f MB (saved %.0f%%)",
                         part_id, src_size / 1048576, out_size / 1048576,
                         (1 - out_size / src_size) * 100)
                _evict_compressed_if_needed()
            else:
                _safe_unlink(out_tmp)
                try:
                    skip.write_text("no-gain")
                except Exception:  # noqa: BLE001
                    pass
                log.info("Transcode of part %d gave no worthwhile gain — keeping original", part_id)
    except Exception:  # noqa: BLE001
        log.exception("Transcode worker failed for part %d", part_id)
        _safe_unlink(out_tmp)
    finally:
        _transcoding.discard(part_id)


def _schedule_transcode(part_id: int, src_path: str) -> None:
    """Fire-and-forget a background transcode if one isn't already done/queued."""
    if not VIDEO_COMPRESS or _transcode_sem is None:
        return
    if part_id in _transcoding:
        return
    if _compressed_path(part_id).exists() or _compressed_skip_path(part_id).exists():
        return
    asyncio.create_task(_transcode_worker(part_id, src_path))
