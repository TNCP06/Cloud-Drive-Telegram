"""Shared configuration, environment, and logging for the bot.

Importing this module loads bot/.env and configures logging (side effects run once).
bot.py re-exports the names that index_history.py imports from `bot`.
"""

import logging
import os

from dotenv import load_dotenv

load_dotenv()  # loads bot/.env when run from the bot/ directory

BOT_TOKEN = os.environ["BOT_TOKEN"]
STORAGE_CHANNEL_ID = int(os.environ["STORAGE_CHANNEL_ID"])
OWNER_USER_ID = int(os.environ["OWNER_USER_ID"])
TELEGRAM_API_URL = os.environ.get("TELEGRAM_API_URL")

# --- PikPak remote-download (bot/pikpak.py) --------------------------------
# rclone pulls a file from the configured remote onto the VPS, then hands it to the
# existing upload_jobs → watcher pipeline. Oversized files are rejected up front.
PIKPAK_REMOTE = os.environ.get("PIKPAK_REMOTE", "pikpak")            # rclone remote name
PIKPAK_MAX_BYTES = int(os.environ.get("PIKPAK_MAX_BYTES", 2 * 1024 * 1024 * 1024))  # 2 GB (MTProto user cap)
PIKPAK_STAGING_DIR = os.environ.get("PIKPAK_STAGING_DIR", "/staging/_pikpak")  # on the shared staging volume
PIKPAK_MAX_CONCURRENT = int(os.environ.get("PIKPAK_MAX_CONCURRENT", 1))  # active downloads
PIKPAK_RETRIES = int(os.environ.get("PIKPAK_RETRIES", 3))           # rclone retries before failing
RCLONE_BIN = os.environ.get("RCLONE_BIN", "rclone")
PIKPAK_DRIVE_FOLDER = os.environ.get("PIKPAK_DRIVE_FOLDER", "pikpak")  # drive folder downloads land in (mirrors remote subdirs)

# --- Multi-drive registry (bot/pikpak.py generic handler) ------------------
# Data-driven drive table: command → rclone remote + path prefix. Adding a new drive
# (Quark, 115, …) means adding one entry to DRIVES_JSON — no code change. Chinese drives
# have no native rclone backend, so they're mounted in a self-hosted OpenList container
# and exposed over WebDAV (one rclone `webdav` remote named `openlist`, prefix = the
# OpenList storage mount path). PikPak keeps its native `pikpak:` remote.
#   remote  = rclone remote name
#   prefix  = path prefix inside that remote (OpenList mount name); '' for a native remote
#   folder  = drive folder in the Telegram drive downloads land under (mirrors subdirs)
#   display = user-facing name in messages
import json as _json  # noqa: E402

_DEFAULT_DRIVES = {
    "pikpak": {"remote": PIKPAK_REMOTE, "prefix": "", "folder": PIKPAK_DRIVE_FOLDER, "display": "PikPak"},
    "baidu":  {"remote": "openlist", "prefix": "baidu", "folder": "baidu", "display": "Baidu Netdisk"},
}
try:
    DRIVES = {**_DEFAULT_DRIVES, **_json.loads(os.environ.get("DRIVES_JSON", "") or "{}")}
except (ValueError, TypeError):
    DRIVES = dict(_DEFAULT_DRIVES)

# Non-media files larger than PIKPAK_MAX_BYTES are split into sequential binary parts of
# this size (MB, must stay under the Telegram upload cap) by the existing watcher.
DRIVE_SPLIT_PART_MB = int(os.environ.get("DRIVE_SPLIT_PART_MB", 1900))


def resolve_drive(key):
    """Return the drive registry entry for a command key (e.g. 'baidu'), or None."""
    return DRIVES.get((key or "").lower())


def drive_remote(drive: dict, remote_path: str) -> str:
    """Build the full rclone target 'remote:prefix/path' for a drive + in-drive path."""
    prefix = (drive.get("prefix") or "").strip("/")
    rel = (remote_path or "").strip("/")
    path = f"{prefix}/{rel}".strip("/") if prefix else rel
    return f'{drive["remote"]}:{path}'


# Postgres DSN (self-hosted). pg_db.database_url() also falls back to POSTGRES_* parts.
from pg_db import database_url as _database_url  # noqa: E402

DATABASE_URL = _database_url()

logging.basicConfig(
    format="%(asctime)s — %(name)s — %(levelname)s — %(message)s",
    level=logging.INFO,
)
# Suppress httpx noise (PTB internal HTTP).
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("cloud-drive-bot")
