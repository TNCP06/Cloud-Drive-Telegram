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
