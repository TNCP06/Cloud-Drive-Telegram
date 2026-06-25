"""One-time fix: backfill file_name for media parts stored as NULL.

Videos/animations whose file_name was NULL are misclassified as images on the
web dashboard. This script re-fetches those messages from Telegram and sets a
proper file_name (e.g. 'video.mp4') so the extension-based type detection works.

Usage (inside the bot container):
    python fix_null_filenames.py
"""

import sys
import os
import asyncio
from dotenv import load_dotenv

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
load_dotenv()

from pg_db import create_client
from bot_config import STORAGE_CHANNEL_ID
from telethon import TelegramClient


async def main():
    db = create_client()

    # Find media parts with no file_name
    rs = await db.execute(
        """
        SELECT p.id, p.channel_msg_id, i.title
        FROM parts p
        JOIN items i ON i.id = p.item_id
        WHERE i.kind = 'media' AND (p.file_name IS NULL OR p.file_name = '')
        ORDER BY p.channel_msg_id
        """
    )

    if not rs.rows:
        print("No media parts with NULL file_name found. Nothing to fix.")
        await db.close()
        return

    print(f"Found {len(rs.rows)} media part(s) with NULL file_name to inspect.\n")

    session_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker")
    tg_api_id = int(os.environ["TG_API_ID"])
    tg_api_hash = os.environ["TG_API_HASH"]

    fixed = 0
    skipped = 0

    async with TelegramClient(session_path, tg_api_id, tg_api_hash) as client:
        entity = await client.get_entity(STORAGE_CHANNEL_ID)

        for part_id, channel_msg_id, title in rs.rows:
            try:
                msgs = await client.get_messages(entity, ids=[channel_msg_id])
                msg = msgs[0] if msgs else None

                if not msg or not msg.media:
                    print(f"  ⚠ msg {channel_msg_id} ({title}): no media found, skipping")
                    skipped += 1
                    continue

                doc = getattr(msg.media, "document", None)
                photo = getattr(msg.media, "photo", None)

                if photo:
                    # Genuine photo — NULL file_name is correct
                    print(f"  · msg {channel_msg_id} ({title}): photo — NULL is correct, skipping")
                    skipped += 1
                    continue

                if doc:
                    mime = msg.file.mime_type or "" if msg.file else ""
                    real_name = msg.file.name if msg.file else None

                    if real_name:
                        new_name = real_name
                    elif mime.startswith("video/"):
                        new_name = "video.mp4"
                    elif mime.startswith("image/"):
                        # Image sent as document — still an image, but give it a name
                        new_name = "image.jpg"
                    else:
                        new_name = None

                    if new_name:
                        await db.execute(
                            "UPDATE parts SET file_name = ? WHERE id = ?",
                            [new_name, part_id],
                        )
                        print(f"  ✓ msg {channel_msg_id} ({title}): set file_name = '{new_name}'")
                        fixed += 1
                    else:
                        print(f"  ⚠ msg {channel_msg_id} ({title}): mime='{mime}', no name to set")
                        skipped += 1
                else:
                    print(f"  ⚠ msg {channel_msg_id} ({title}): unknown media type, skipping")
                    skipped += 1

            except Exception as e:
                print(f"  ✗ msg {channel_msg_id} ({title}): error — {e}")
                skipped += 1

    await db.close()
    print(f"\nDone! Fixed: {fixed}, Skipped: {skipped}")


if __name__ == "__main__":
    asyncio.run(main())
