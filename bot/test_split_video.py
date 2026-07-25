"""Standalone check for watcher.split_video — no network, no DB, no framework.

    python test_split_video.py

Builds a small synthetic video with ffmpeg, cuts it with a deliberately tiny segment
target, and asserts the parts are REAL playable videos that add back up to the original
(the whole point of segmenting instead of raw byte-splitting). Skips if ffmpeg is missing.

Stubs watcher's heavy imports (telethon / pg_db / dotenv / worker) like test_volume_no.py.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import types

os.environ.setdefault("TG_API_ID", "1")
os.environ.setdefault("TG_API_HASH", "x")
os.environ.setdefault("STORAGE_CHANNEL_ID", "-1000000000000")
os.environ.setdefault("BOT_TOKEN", "x")          # watcher → unpack → bot_config
os.environ.setdefault("OWNER_USER_ID", "1")

for name in ("telethon", "pg_db", "dotenv", "worker"):
    if name not in sys.modules:
        sys.modules[name] = types.ModuleType(name)
sys.modules["telethon"].TelegramClient = object
sys.modules["telethon.errors"] = types.ModuleType("telethon.errors")
sys.modules["telethon.errors"].FloodError = type("FloodError", (Exception,), {})
sys.modules["pg_db"].create_client = lambda *a, **k: None
sys.modules["pg_db"].database_url = lambda *a, **k: "postgresql://x/x"
sys.modules["dotenv"].load_dotenv = lambda *a, **k: None
for fn in ("normalize_tags", "build_caption", "collect_parts"):
    setattr(sys.modules["worker"], fn, lambda *a, **k: None)
sys.modules["worker"].safe_name = lambda s: s

import watcher  # noqa: E402

if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
    print("SKIP — ffmpeg/ffprobe not on PATH")
    raise SystemExit(0)

DURATION = 30
work = tempfile.mkdtemp(prefix="tcd_split_test_")
try:
    watcher.OUT_DIR = os.path.join(work, "out")
    src = os.path.join(work, "source clip.mp4")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc=duration={DURATION}:size=640x480:rate=30",
         "-c:v", "libx264", "-g", "30", "-b:v", "2M", "-pix_fmt", "yuv420p", src],
        check=True, capture_output=True,
    )
    size = os.path.getsize(src)
    assert size > 1024 * 1024, f"test clip too small to split meaningfully ({size} B)"

    # Stand-in for the real 1800 MB target / 2 GB cap, scaled down to this clip.
    watcher.VIDEO_SEGMENT_MB = 1
    watcher.PIKPAK_MAX_BYTES = 1024 * 1024

    parts = watcher.split_video(src)
    assert len(parts) >= 2, f"expected multiple segments, got {parts}"
    assert parts == sorted(parts), "segments must come back in playback order"

    total = 0.0
    for p in parts:
        assert os.path.getsize(p) <= watcher.PIKPAK_MAX_BYTES, f"{p} is over the cap"
        d = watcher.video_duration(p)          # 0.0 for anything ffprobe can't open
        assert d > 0, f"segment is not a playable video: {p}"
        total += d
    assert abs(total - DURATION) < 1.5, f"segments cover {total:.2f}s of {DURATION}s"

    # The plan builder must route an oversized video through the splitter (as media, NOT as a
    # document), and hand a file that already fits straight to a single-part upload.
    kind, files, as_doc = watcher.plan_media(src)
    assert kind == "list" and files != [src] and as_doc is False, (kind, as_doc)
    watcher.PIKPAK_MAX_BYTES = 2000 * 1024 * 1024
    assert watcher.plan_media(src) == ("list", [src], False)

    print(f"OK — {len(parts)} playable segments, {total:.2f}s total")
finally:
    shutil.rmtree(work, ignore_errors=True)
