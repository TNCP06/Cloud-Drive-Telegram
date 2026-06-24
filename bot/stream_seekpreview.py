"""
Telegram Cloud Drive — seek-preview sprite-sheet generator.

Generates a grid of thumbnail frames from a video file using ffmpeg, plus a
companion WebVTT file that maps each time interval to a region of the sprite
sheet.  The VTT is consumed by Plyr's `previewThumbnails` feature so users see
a frame preview when hovering the progress bar.

Layout
------
- Sprites live under ``SEEKPREVIEW_DIR / f"part_{part_id}"``.
- Each part directory contains ``sprite.jpg`` and ``preview.vtt``.
- A ``.done`` marker indicates a completed job (skip on re-run).

The sprite grid is COLS×ROWS (default 10×10 = 100 frames).  If the video has
fewer seconds than frames, interval is clamped to 1 s so we just get fewer
frames.  Sprite dimensions are configurable via environment variables.
"""

import asyncio
import logging
import math
import os
import shutil
from pathlib import Path

log = logging.getLogger("streamer")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SEEKPREVIEW_DIR = Path(os.environ.get("SEEKPREVIEW_DIR", "/seekpreviews"))

# Sprite grid layout
SPRITE_COLS = int(os.environ.get("SEEKPREVIEW_COLS", "10"))
SPRITE_ROWS = int(os.environ.get("SEEKPREVIEW_ROWS", "10"))
SPRITE_MAX_FRAMES = SPRITE_COLS * SPRITE_ROWS  # 100 by default

# Each individual thumbnail size (width × height pixels)
THUMB_W = int(os.environ.get("SEEKPREVIEW_THUMB_W", "128"))
THUMB_H = int(os.environ.get("SEEKPREVIEW_THUMB_H", "72"))

# Concurrency limiter (shared with the caller — initialised in the running loop)
_sem: asyncio.Semaphore | None = None


def init_seekpreview_semaphore() -> None:
    global _sem
    _sem = asyncio.Semaphore(1)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _part_dir(part_id: int) -> Path:
    return SEEKPREVIEW_DIR / f"part_{part_id}"


def sprite_path(part_id: int) -> Path:
    return _part_dir(part_id) / "sprite.jpg"


def vtt_path(part_id: int) -> Path:
    return _part_dir(part_id) / "preview.vtt"


def is_done(part_id: int) -> bool:
    return (_part_dir(part_id) / ".done").exists()


def has_preview(part_id: int) -> bool:
    """Return True if a completed seek-preview exists for this part."""
    return is_done(part_id) and vtt_path(part_id).exists() and sprite_path(part_id).exists()


async def _probe_duration(src_path: str) -> float | None:
    """Use ffprobe to get the video duration in seconds."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            src_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0 and stdout.strip():
            return float(stdout.strip())
    except Exception as e:
        log.warning("ffprobe failed for %s: %s", src_path, e)
    return None


def _generate_vtt(duration: float, interval: float, n_frames: int,
                  sprite_url: str) -> str:
    """Build a WebVTT string mapping each interval to a sprite-sheet region.

    Each cue's text is ``sprite_url#xywh=x,y,w,h`` — the format Plyr expects.
    """
    lines = ["WEBVTT", ""]
    for i in range(n_frames):
        t_start = i * interval
        t_end = min((i + 1) * interval, duration)
        col = i % SPRITE_COLS
        row = i // SPRITE_COLS
        x = col * THUMB_W
        y = row * THUMB_H
        lines.append(f"{_fmt_ts(t_start)} --> {_fmt_ts(t_end)}")
        lines.append(f"{sprite_url}#xywh={x},{y},{THUMB_W},{THUMB_H}")
        lines.append("")
    return "\n".join(lines)


def _fmt_ts(seconds: float) -> str:
    """Format seconds as ``HH:MM:SS.mmm``."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


# ---------------------------------------------------------------------------
# Main generation routine
# ---------------------------------------------------------------------------
async def generate_seek_preview(part_id: int, src_path: str) -> bool:
    """Generate sprite sheet + VTT for a video file.

    Returns True on success, False on failure or if the video is too short.
    Skips silently if a completed preview already exists.
    """
    if is_done(part_id):
        return True

    if _sem is None:
        init_seekpreview_semaphore()

    async with _sem:
        # Re-check after acquiring the semaphore (another request may have finished it)
        if is_done(part_id):
            return True

        duration = await _probe_duration(src_path)
        if duration is None or duration < 2:
            log.info("Seek preview skipped for part %d — too short or unreadable (%.1fs)",
                     part_id, duration or 0)
            # Mark as done so we don't retry
            d = _part_dir(part_id)
            d.mkdir(parents=True, exist_ok=True)
            (d / ".done").touch()
            return False

        # Calculate interval: spread SPRITE_MAX_FRAMES evenly across the duration,
        # but never less than 1 s per frame.
        interval = max(1.0, duration / SPRITE_MAX_FRAMES)
        n_frames = min(SPRITE_MAX_FRAMES, max(1, int(math.ceil(duration / interval))))
        # Recalculate actual rows needed (may be fewer than SPRITE_ROWS for short videos)
        actual_rows = math.ceil(n_frames / SPRITE_COLS)

        log.info("Generating seek preview for part %d: %.0fs, %d frames @ %.1fs interval, %dx%d grid",
                 part_id, duration, n_frames, interval, SPRITE_COLS, actual_rows)

        d = _part_dir(part_id)
        d.mkdir(parents=True, exist_ok=True)
        tmp_sprite = d / "sprite.tmp.jpg"
        final_sprite = sprite_path(part_id)

        try:
            # ffmpeg command: extract frames at interval, scale, tile into a grid.
            # -vf "fps=1/{interval},scale={w}:{h},tile={cols}x{rows}"
            fps_val = 1 / interval
            cmd = [
                "ffmpeg", "-y",
                "-i", src_path,
                "-vf", f"fps={fps_val:.6f},scale={THUMB_W}:{THUMB_H}:force_original_aspect_ratio=decrease,pad={THUMB_W}:{THUMB_H}:(ow-iw)/2:(oh-ih)/2,tile={SPRITE_COLS}x{actual_rows}",
                "-frames:v", "1",
                "-q:v", "6",  # JPEG quality (2=best, 31=worst) — 6 is a good size/quality tradeoff
                str(tmp_sprite),
            ]

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()

            if proc.returncode != 0:
                log.error("ffmpeg seek-preview failed for part %d (rc=%d): %s",
                          part_id, proc.returncode, stderr[-500:].decode(errors="replace"))
                tmp_sprite.unlink(missing_ok=True)
                return False

            if not tmp_sprite.exists() or tmp_sprite.stat().st_size == 0:
                log.error("ffmpeg produced no output for part %d", part_id)
                tmp_sprite.unlink(missing_ok=True)
                return False

            # Atomically promote the sprite
            shutil.move(str(tmp_sprite), str(final_sprite))

            # Generate VTT — the sprite URL is relative (resolved by the API proxy)
            vtt_content = _generate_vtt(duration, interval, n_frames, "sprite")
            vtt_path(part_id).write_text(vtt_content, encoding="utf-8")

            # Mark complete
            (d / ".done").touch()
            log.info("Seek preview ready for part %d: %d frames, sprite %.1f KB",
                     part_id, n_frames, final_sprite.stat().st_size / 1024)
            return True

        except Exception:
            log.exception("Seek preview generation failed for part %d", part_id)
            tmp_sprite.unlink(missing_ok=True)
            return False
