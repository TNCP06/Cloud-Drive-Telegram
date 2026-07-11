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

import pikpak  # noqa: E402


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
    # Mirrors the remote subfolders under the pikpak drive folder; strips the file extension.
    assert pikpak._drive_title("Movies/Action/x.mkv", "x.mkv") == "pikpak/Movies/Action/x"
    assert pikpak._drive_title("x.mkv", "x.mkv") == "pikpak/x"
    assert pikpak._drive_title("/A/b.iso", "b.iso") == "pikpak/A/b"


def test_is_media():
    assert pikpak._is_media("clip.mkv")
    assert pikpak._is_media("photo.JPG")       # case-insensitive; images → media (thumbnail/preview)
    assert not pikpak._is_media("archive.zip")
    assert not pikpak._is_media("noext")


def test_classify_error():
    assert "rclone config" in pikpak._classify_rclone_error("didn't find section in config file", "p")
    assert "auth failed" in pikpak._classify_rclone_error("oauth token expired: invalid_grant", "p")
    assert "Path not found" in pikpak._classify_rclone_error("directory not found", "movies/x")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    print("All pikpak checks passed.")
