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
