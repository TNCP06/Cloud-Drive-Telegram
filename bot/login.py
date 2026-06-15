"""
Login sekali untuk membuat worker.session (Telethon).

Jalankan INTERAKTIF di terminal laptop:
    python login.py

Akan meminta:
  1. Nomor telepon (format internasional, mis. +62812xxxxxxx)
  2. Kode OTP yang dikirim Telegram ke akunmu
  3. (jika aktif) password 2FA

Setelah sukses, worker.session tersimpan dan worker.py bisa dijalankan tanpa login lagi.
JANGAN commit *.session (sudah di .gitignore) — itu = akses penuh ke akun.
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
        print(f"\n✓ Login sukses sebagai: {me.first_name} (@{me.username}) id={me.id}")
        print(f"✓ Session tersimpan: {SESSION}.session — worker.py siap dipakai.")


if __name__ == "__main__":
    asyncio.run(main())
