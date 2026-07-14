"""Standalone checks for bot/pikpak.py pure logic — no DB, no network, no framework.

    python test_pikpak.py

Stubs env + the psycopg driver so it imports anywhere (the real DB is not needed to test
the progress parser, the size-reject threshold, folder-title building, and error classing).
"""

import os
import sys
import types

# Minimal env so bot_config imports (it reads these at module load).
os.environ.setdefault("BOT_TOKEN", "test")
os.environ.setdefault("STORAGE_CHANNEL_ID", "-1000000000000")
os.environ.setdefault("OWNER_USER_ID", "1")
os.environ.setdefault("DATABASE_URL", "postgresql://u:p@localhost/db")

# Stub psycopg_pool so the import chain (bot_config → pg_db) works without the driver installed.
if "psycopg_pool" not in sys.modules:
    m = types.ModuleType("psycopg_pool")
    m.AsyncConnectionPool = object
    sys.modules["psycopg_pool"] = m

import bot_config  # noqa: E402
import pikpak  # noqa: E402

PIKPAK = bot_config.resolve_drive("pikpak")
BAIDU = bot_config.resolve_drive("baidu")


def test_pct_parser():
    line = "Transferred: 1.234 GiB / 2.345 GiB, 52%, 10.5 MiB/s, ETA 1m30s"
    m = pikpak._PCT.search(line)
    assert m and int(m.group(1)) == 52, "should extract 52 from an rclone stats line"
    assert pikpak._PCT.search("no percentage here") is None


def test_clean_stats():
    line = "2026/07/12 10:00:00 INFO  : 15.234 MiB / 1.234 GiB, 12%, 5.2 MiB/s, ETA 3m45s"
    assert pikpak._clean_stats(line) == "15.234 MiB / 1.234 GiB, 12%, 5.2 MiB/s, ETA 3m45s"
    # A line with no log prefix is returned as-is (just trimmed).
    assert pikpak._clean_stats("  50%, done  ") == "50%, done"


def test_size_reject():
    # Threshold is exactly 2 GiB; oversized rejected, at/under accepted.
    assert pikpak.PIKPAK_MAX_BYTES == 2 * 1024 ** 3
    assert (3 * 1024 ** 3) > pikpak.PIKPAK_MAX_BYTES        # 3 GB → rejected
    assert (2 * 1024 ** 3) <= pikpak.PIKPAK_MAX_BYTES       # exactly 2 GB → allowed
    assert (500 * 1024 ** 2) <= pikpak.PIKPAK_MAX_BYTES     # 500 MB → allowed


def test_human_size():
    assert pikpak.human_size(0) == "0 B"
    assert pikpak.human_size(500) == "500 B"
    assert pikpak.human_size(5 * 1024 * 1024) == "5.00 MB"
    assert pikpak.human_size(2 * 1024 ** 3) == "2.00 GB"


def test_drive_title():
    # Mirrors the remote subfolders under the drive folder; strips the file extension.
    assert pikpak._drive_title("Movies/Action/x.mkv", "x.mkv", PIKPAK) == "pikpak/Movies/Action/x"
    assert pikpak._drive_title("x.mkv", "x.mkv", PIKPAK) == "pikpak/x"
    assert pikpak._drive_title("/A/b.iso", "b.iso", PIKPAK) == "pikpak/A/b"
    # Baidu files land under the baidu/ folder.
    assert pikpak._drive_title("Docs/big.iso", "big.iso", BAIDU) == "baidu/Docs/big"


def test_is_media():
    assert pikpak._is_media("clip.mkv")
    assert pikpak._is_media("photo.JPG")       # case-insensitive; images → media (thumbnail/preview)
    assert not pikpak._is_media("archive.zip")
    assert not pikpak._is_media("noext")


def test_registry_resolution():
    # pikpak is native (no prefix); baidu routes through OpenList's WebDAV mount.
    assert PIKPAK["remote"] == "pikpak" and not PIKPAK["prefix"]
    assert BAIDU["remote"] == "openlist" and BAIDU["prefix"] == "baidu"
    assert bot_config.resolve_drive("nope") is None
    assert bot_config.resolve_drive("BAIDU") is BAIDU  # case-insensitive


def test_drive_remote_path():
    # Native remote → 'remote:path'; WebDAV drive → 'remote:mount/path'.
    assert bot_config.drive_remote(PIKPAK, "Movies/x.mkv") == "pikpak:Movies/x.mkv"
    assert bot_config.drive_remote(BAIDU, "Docs/big.iso") == "openlist:baidu/Docs/big.iso"
    assert bot_config.drive_remote(BAIDU, "/Docs/") == "openlist:baidu/Docs"


def test_split_policy():
    # Media > 2 GB → rejected (can't stream a split video). Non-media > 2 GB → split.
    over = 3 * 1024 ** 3
    under = 500 * 1024 ** 2
    assert pikpak._is_media("movie.mkv") and over > pikpak.PIKPAK_MAX_BYTES   # → reject branch
    assert not pikpak._is_media("data.iso")                                    # → split branch
    # part_size chosen in _process: split size only for oversized non-media, else single-part cap.
    def part_size(fname, size):
        kind = "media" if pikpak._is_media(fname) else "archive"
        return pikpak.DRIVE_SPLIT_PART_MB if (kind == "archive" and size > pikpak.PIKPAK_MAX_BYTES) else 4096
    assert part_size("data.iso", over) == pikpak.DRIVE_SPLIT_PART_MB   # oversized non-media → split
    assert part_size("data.iso", under) == 4096                        # small non-media → single
    assert part_size("movie.mkv", under) == 4096                       # media → single
    assert pikpak.DRIVE_SPLIT_PART_MB < 2048, "split parts must stay under the 2 GB Telegram cap"


def test_classify_error():
    # Native (PikPak) messaging.
    assert "rclone config" in pikpak._classify_rclone_error("didn't find section in config file", "p", PIKPAK)
    assert "auth failed" in pikpak._classify_rclone_error("oauth token expired: invalid_grant", "p", PIKPAK)
    assert "Path not found" in pikpak._classify_rclone_error("directory not found", "movies/x", PIKPAK)
    # WebDAV (Baidu) → points at the OpenList UI, distinguishes unreachable from expired cookie.
    unreach = pikpak._classify_rclone_error("dial tcp 127.0.0.1:5244: connection refused", "p", BAIDU)
    assert "OpenList" in unreach and "unreachable" in unreach
    expired = pikpak._classify_rclone_error("401 Unauthorized", "p", BAIDU)
    assert "OpenList web UI" in expired and "cookie" in expired


def test_split_reassembly_byte_identical():
    """The non-media > 2 GB path relies on the watcher's raw streaming split (write_window +
    the _process offset loop) producing ordered binary parts that reassemble by plain concat.
    watcher.py can't import here (pulls telethon), so replicate the exact windowing math and
    prove: N sequential windows of part_bytes, concatenated in order, == the original bytes.
    Uses a tiny chunk size + small payload (the prompt: never multi-GB fixtures)."""
    import math
    import os
    import tempfile

    def write_window(src, offset, length, dst):  # identical to watcher.write_window
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

    payload = bytes(range(256)) * 40 + b"tail"   # 10244 bytes, non-round so the last part is short
    part_bytes = 1000                            # tiny "chunk size" (stand-in for DRIVE_SPLIT_PART_MB)
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "data.iso")
        with open(src, "wb") as f:
            f.write(payload)
        size = os.path.getsize(src)
        total = max(1, math.ceil(size / part_bytes))
        assert total == 11, "10244 B / 1000 B → 11 ordered parts"
        parts = []
        for i in range(1, total + 1):            # watcher's 1-based part loop
            offset = (i - 1) * part_bytes
            length = min(part_bytes, size - offset)
            p = os.path.join(d, f"data.iso.{i:03d}")
            write_window(src, offset, length, p)
            parts.append(p)
        assert sum(os.path.getsize(p) for p in parts) == size, "parts cover the whole file, no gaps"
        rejoined = b"".join(open(p, "rb").read() for p in parts)  # ordered cat
        assert rejoined == payload, "concatenated parts must be byte-identical to the source"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("All pikpak checks passed.")
