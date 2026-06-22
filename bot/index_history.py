"""
Index history: manually back-index channel messages using Telethon (worker.session)
and upsert them to Turso catalog.

Usage:
    python index_history.py
"""

import sys
import os
import asyncio
from dotenv import load_dotenv

# Add current folder to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from bot import (
    upsert_item,
    upsert_part,
    recompute_totals,
    sync_tags,
    sync_album_tags,
    detect_kind,
    parse_caption,
    derive_media_meta,
    get_file_meta,
    slugify,
    STORAGE_CHANNEL_ID
)
from pg_db import create_client
from telethon import TelegramClient

# Load environment variables
load_dotenv()

# Adapter classes to mock python-telegram-bot's Message object
class DocumentAdapter:
    def __init__(self, name, size, mime):
        self.file_id = ""
        self.file_name = name
        self.file_size = size
        self.mime_type = mime

class VideoAdapter:
    def __init__(self, name, size):
        self.file_id = ""
        self.file_name = name
        self.file_size = size

class PhotoAdapter:
    def __init__(self, size):
        self.file_id = ""
        self.file_size = size

class MessageAdapter:
    def __init__(self, msg):
        self.caption = msg.message or ""
        self.message_id = msg.id
        self.media_group_id = msg.grouped_id
        self.date = msg.date
        
        self.document = None
        self.video = None
        self.animation = None
        self.photo = None
        
        if msg.media:
            # Check if it's photo
            if getattr(msg.media, 'photo', None):
                self.photo = [PhotoAdapter(msg.file.size if msg.file else 0)]
            # Check if it's video or document
            elif getattr(msg.media, 'document', None):
                mime = msg.file.mime_type or ""
                name = msg.file.name or ""
                size = msg.file.size or 0
                if mime.startswith("video/"):
                    self.video = VideoAdapter(name, size)
                else:
                    self.document = DocumentAdapter(name, size, mime)

async def index_message(db, msg):
    kind = detect_kind(msg)
    if kind is None:
        return False
        
    parsed = parse_caption(msg.caption)
    has_caption = parsed is not None
    if parsed is None:
        if kind == "media":
            parsed, has_caption = derive_media_meta(msg)
        else:
            print(f"Skipping Message {msg.message_id}: archive without valid caption contract")
            return False
            
    title = parsed["title"]
    mgid = msg.media_group_id
    
    if kind == "media" and mgid:
        # Album members are individual items (NOT grouped); slug keyed off media_group_id so
        # siblings stay discoverable for tag-syncing, unique per member via msg_id. Single-part.
        slug = f"m{mgid}-{msg.message_id}"
        part_number = 1
        total = 1
    elif kind == "media":
        slug = f"{slugify(title)}-{msg.message_id}"
        part_number = parsed["part"]
        total = parsed["total"]
    else:
        slug = slugify(title)
        part_number = parsed["part"]
        total = parsed["total"]

    file_name, file_size = get_file_meta(msg)
    file_id = "" # Streamer resolves file_id on-demand via forwarding if missing

    item_id = await upsert_item(db, slug, title, kind, total, set_title=has_caption)
    part_id = await upsert_part(db, item_id, part_number, msg.message_id, file_name, file_size, file_id)

    await recompute_totals(db, item_id)
    await sync_tags(db, item_id, parsed["tags"])
    if kind == "media" and mgid:
        await sync_album_tags(db, mgid, parsed["tags"])
    print(f"✓ Indexed Message {msg.message_id}: {title} (Part {part_number}/{parsed['total']}) -> Slug: {slug}")
    return True

async def main():
    print("Connecting to PostgreSQL database...")
    db = create_client()
    
    # Fetch already indexed message IDs from the database to skip them
    print("Fetching already indexed channel_msg_ids from database...")
    existing_rs = await db.execute("SELECT channel_msg_id FROM parts")
    existing_ids = {row[0] for row in existing_rs.rows}
    print(f"Found {len(existing_ids)} messages already indexed.")

    # Initialize Telethon Client using worker.session
    session_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker")
    print(f"Starting Telethon client with session: {session_path}...")
    
    tg_api_id = int(os.environ["TG_API_ID"])
    tg_api_hash = os.environ["TG_API_HASH"]
    async with TelegramClient(session_path, tg_api_id, tg_api_hash) as client:
        print(f"Connecting to channel ID: {STORAGE_CHANNEL_ID}...")
        entity = await client.get_entity(STORAGE_CHANNEL_ID)
        
        print("Fetching channel messages...")
        count = 0
        async for raw_msg in client.iter_messages(entity):
            if raw_msg.id in existing_ids:
                continue
            adapter = MessageAdapter(raw_msg)
            try:
                success = await index_message(db, adapter)
                if success:
                    count += 1
            except Exception as e:
                print(f"Error indexing message {raw_msg.id}: {e}")
                
        print(f"\nDone! Successfully indexed {count} messages.")
    
    await db.close()

if __name__ == "__main__":
    asyncio.run(main())
