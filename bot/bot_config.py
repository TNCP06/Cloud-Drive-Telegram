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
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")
TELEGRAM_API_URL = os.environ.get("TELEGRAM_API_URL")


def _turso_http_url(url: str) -> str:
    # libsql_client WebSocket transport is rejected by Turso (HTTP 400) → use HTTPS (Hrana over HTTP).
    if url.startswith("libsql://"):
        return "https://" + url[len("libsql://") :]
    return url


TURSO_DATABASE_URL = _turso_http_url(os.environ["TURSO_DATABASE_URL"])

logging.basicConfig(
    format="%(asctime)s — %(name)s — %(levelname)s — %(message)s",
    level=logging.INFO,
)
# Suppress httpx noise (PTB internal HTTP).
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("cloud-drive-bot")
