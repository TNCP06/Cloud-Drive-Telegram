"""
One-time login to create worker.session (Telethon).

Run INTERACTIVELY in a terminal on the laptop:
    python login.py

You will be prompted for:
  1. Phone number (international format, e.g. +1-555-123-4567)
  2. OTP code sent by Telegram to your account
  3. (if enabled) 2FA password

After success, worker.session is saved and worker.py can run without logging in again.
DO NOT commit *.session (already in .gitignore) — it grants full access to the account.
"""

import asyncio
import os

from dotenv import load_dotenv
from telethon import TelegramClient

load_dotenv()
API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
SESSION = os.environ.get("WORKER_SESSION", "worker")


async def main():
    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        me = await client.get_me()
        print(f"\n✓ Login successful: {me.first_name} (@{me.username}) id={me.id}")
        print(f"✓ Session saved: {SESSION}.session — worker.py is ready to use.")


if __name__ == "__main__":
    asyncio.run(main())
