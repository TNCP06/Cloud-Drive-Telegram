"""Standalone check for watcher._volume_no — no network, no DB, no framework.

    python test_volume_no.py

Stubs watcher's heavy imports (telethon / pg_db / dotenv / worker) so the pure
part-number parser can be imported and exercised anywhere.
"""

import os
import sys
import types

os.environ.setdefault("TG_API_ID", "1")
os.environ.setdefault("TG_API_HASH", "x")
os.environ.setdefault("STORAGE_CHANNEL_ID", "-1000000000000")

for name in ("telethon", "pg_db", "dotenv", "worker"):
    if name not in sys.modules:
        sys.modules[name] = types.ModuleType(name)
sys.modules["telethon"].TelegramClient = object
sys.modules["pg_db"].create_client = lambda *a, **k: None
sys.modules["dotenv"].load_dotenv = lambda *a, **k: None
for fn in ("normalize_tags", "build_caption", "safe_name", "collect_parts"):
    setattr(sys.modules["worker"], fn, lambda *a, **k: None)

from watcher import _volume_no  # noqa: E402

cases = {
    # 7-Zip / numeric split
    "364B.7z.001": 1,
    "364B.7z.002": 2,
    "movie.mkv.012": 12,
    "archive.zip.001": 1,
    # modern RAR
    "pack.part1.rar": 1,
    "pack.part01.rar": 1,
    "pack.part12.rar": 12,
    "PACK.PART3.RAR": 3,
    # NOT volumes → single file (None)
    "backup.2024": None,      # bare .NNN, no .EXT. in front → not a volume
    "movie.480": None,
    "clip.mp4": None,
    "364B.7z": None,
    "pack.rar": None,         # old-RAR base intentionally unhandled
    "data.z01": None,         # split-zip intentionally unhandled
}
for name, want in cases.items():
    got = _volume_no("/staging/" + name)
    assert got == want, f"{name!r}: got {got}, want {want}"

print(f"OK — {len(cases)} cases")
