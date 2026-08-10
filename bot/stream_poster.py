"""
Telegram Cloud Drive — video poster thumbnails (ffmpeg).

Why this exists
---------------
At index time a video's thumbnail comes from `message.video.thumbnail` (see
`tg_helpers.pick_thumb_file_id`), and Telegram caps that image at ~320 px on its longest
edge. A photo, by contrast, is stored from the full-size original down to
`THUMB_MAX_EDGE` (1280 px). So in a video-heavy drive every grid card shows a 320 px
image upscaled into a 200–260 px-wide box that keeps growing with the window — visibly
soft, and the Bot API offers no larger variant.

ffmpeg is already installed in this container (seek-preview sprites, transcode) and the
streamer already materialises the whole video on disk, so a poster costs one extra frame
decode over a file that is right there. The frame replaces the Telegram thumbnail in
`thumbnails`, tagged `source = 'ffmpeg'` so it is never re-done and never overwrites a
cover the user picked by hand (`source = 'manual'`).
"""

import asyncio
import base64
import logging
import os
from pathlib import Path

from stream_seekpreview import _probe_duration  # same ffprobe call, no reason to have two

log = logging.getLogger("streamer")

# Longest edge of a generated poster. Matches tg_helpers.THUMB_MAX_EDGE (photos), so a video
# cover ends up as sharp as a photo cover.
POSTER_MAX_EDGE = int(os.environ.get("POSTER_MAX_EDGE", "1280"))
# Where in the video to grab the frame, as a fraction of duration. Not 0: the first frames are
# very often a black fade-in or a title card, which makes for a useless cover.
POSTER_SEEK_RATIO = float(os.environ.get("POSTER_SEEK_RATIO", "0.1"))
# WebP quality. Higher than the 80 the Telegram-thumbnail path uses: this image is the cover in
# every grid and the still behind a video, and the extra few KB buy visibly cleaner gradients.
POSTER_QUALITY = int(os.environ.get("POSTER_QUALITY", "88"))
# How many consecutive frames ffmpeg's `thumbnail` filter weighs before picking the most
# representative one. A single grabbed frame is a gamble — it lands on a fade, a motion blur or a
# black cut often enough to matter; scoring a couple of seconds' worth costs one extra decode.
POSTER_CANDIDATE_FRAMES = int(os.environ.get("POSTER_CANDIDATE_FRAMES", "100"))

# Retroactive pass over videos indexed before posters existed. Each one costs a full download
# of the original, so it is paced, runs one at a time, and yields to anything the user is
# actually watching. Set POSTER_BACKFILL=0 to leave old covers alone.
POSTER_BACKFILL = os.environ.get("POSTER_BACKFILL", "1") not in ("0", "false", "False", "no")
POSTER_BACKFILL_START_DELAY_S = int(os.environ.get("POSTER_BACKFILL_START_DELAY_S", "120"))
POSTER_BACKFILL_INTERVAL_S = int(os.environ.get("POSTER_BACKFILL_INTERVAL_S", "60"))
POSTER_BACKFILL_IDLE_S = int(os.environ.get("POSTER_BACKFILL_IDLE_S", "3600"))

# Pick the best of N frames, then fit the longest edge to POSTER_MAX_EDGE without ever upscaling,
# keeping both sides even (-2) so any encoder accepts the frame. Lanczos because this is a
# downscale of a single still — the sharpest resampler here costs nothing at one frame.
_VF = (
    f"thumbnail={POSTER_CANDIDATE_FRAMES},"
    f"scale='if(gt(iw,ih),min({POSTER_MAX_EDGE},iw),-2)':"
    f"'if(gt(iw,ih),-2,min({POSTER_MAX_EDGE},ih))':flags=lanczos"
)

# One poster at a time, so a backfill never fights the transcode/sprite ffmpegs for CPU.
_sem: asyncio.Semaphore | None = None


def init_poster_semaphore() -> None:
    global _sem
    _sem = asyncio.Semaphore(1)


async def _run_ffmpeg(cmd: list[str]) -> bool:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        log.debug("ffmpeg poster attempt failed (rc=%s): %s",
                  proc.returncode, stderr[-300:].decode(errors="replace"))
        return False
    return True


async def generate_poster(part_id: int, src_path: str, tmp_dir: str = "/tmp") -> tuple[str, str] | None:
    """Grab one frame from `src_path` → (mime, base64). None when the video can't be read.

    WebP first (what the Telegram-thumbnail path stores too, ~25-35% smaller than JPEG at
    equal quality); JPEG is the fallback for an ffmpeg build without libwebp, so a poster is
    never lost over an encoder that isn't there.
    """
    if _sem is None:
        init_poster_semaphore()

    async with _sem:
        duration = await _probe_duration(src_path)
        # Seek 10% in, but never past a short clip's end; 1 s covers a duration-less probe.
        seek = max(1.0, duration * POSTER_SEEK_RATIO) if duration else 1.0
        if duration and seek >= duration:
            seek = duration / 2

        tmp = Path(tmp_dir) / f"poster_{part_id}.tmp"
        for mime, args in (
            # `-preset picture` tunes libwebp for photographic stills rather than its default
            # mixed-content profile; `-compression_level 6` spends more encoder time for a smaller
            # file at the same quality, which is free here (one frame, off the request path).
            ("image/webp", ["-c:v", "libwebp", "-quality", str(POSTER_QUALITY),
                            "-preset", "picture", "-compression_level", "6", "-f", "webp"]),
            ("image/jpeg", ["-q:v", "2", "-f", "mjpeg"]),
        ):
            tmp.unlink(missing_ok=True)
            # `-ss` BEFORE `-i` seeks by keyframe without decoding everything up to it — the
            # difference between instant and minutes on a long video.
            ok = await _run_ffmpeg([
                "ffmpeg", "-y", "-ss", f"{seek:.3f}", "-i", src_path,
                "-frames:v", "1", "-vf", _VF, *args, str(tmp),
            ])
            if ok and tmp.exists() and tmp.stat().st_size > 0:
                try:
                    data = tmp.read_bytes()
                    log.info("Poster generated for part %d at %.1fs: %s, %.1f KB",
                             part_id, seek, mime, len(data) / 1024)
                    return mime, base64.b64encode(data).decode("ascii")
                finally:
                    tmp.unlink(missing_ok=True)

        tmp.unlink(missing_ok=True)
        log.warning("Poster generation failed for part %d (%s)", part_id, src_path)
        return None


async def store_poster(db, part_id: int, src_path: str) -> bool:
    """Generate a poster and write it over the part's thumbnail. Never raises."""
    try:
        made = await generate_poster(part_id, src_path)
        if not made:
            return False
        mime, data_b64 = made
        await db.execute(
            """
            INSERT INTO thumbnails (part_id, mime, data, source) VALUES (?, ?, ?, 'ffmpeg')
            ON CONFLICT(part_id) DO UPDATE
               SET mime = excluded.mime, data = excluded.data, source = 'ffmpeg'
            """,
            [part_id, mime, data_b64],
        )
        return True
    except Exception:  # noqa: BLE001
        log.exception("Storing poster failed for part %d", part_id)
        return False
