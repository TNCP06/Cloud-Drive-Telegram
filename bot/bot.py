"""
Telegram Cloud Drive — bot indexer.

Milestone 2 (+ album & media-fallback): channel_post handler.
Flow: every new file posted to STORAGE_CHANNEL_ID → parse caption
(contract: "Title | part/total | tag1, tag2") → upsert into Turso (items + parts + tags).
- ARCHIVE : caption REQUIRED (title = grouping key, part/total = assembly order). Invalid →
  warn owner so no file silently goes missing.
- MEDIA: caption OPTIONAL. Without a valid caption, metadata is derived from the free-form
  caption / filename / date (see derive_media_meta) → media is never lost.
- ALBUM (media group: multiple photos/videos sent at once) → merged into ONE multi-part item
  via media_group_id; each part has its own thumbnail (gallery in the web UI).
Telegram's built-in thumbnails are harvested per-part into the `thumbnails` table.

API notes:
- Bot must be admin in the channel to receive channel_post updates.
- Thumbnails are fetched via get_file (small, under the 20 MB limit) — media only.
"""

import asyncio
import base64
import html
import io
import logging
import os
import re
import unicodedata
from datetime import time as dtime

import httpx
import libsql_client
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, BotCommand, BotCommandScopeChat, BotCommandScopeDefault
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
    CallbackQueryHandler,
)

# ---------------------------------------------------------------------------
# Configuration & environment
# ---------------------------------------------------------------------------
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

# Caption contract: "Title | part/total | tag1, tag2"
CAPTION_RE = re.compile(
    r"^(?P<title>.+?)\s*\|\s*(?P<part>\d+)\s*/\s*(?P<total>\d+)\s*\|\s*(?P<tags>.*)$"
)

# ---------------------------------------------------------------------------
# Pure helpers (no I/O)
# ---------------------------------------------------------------------------
def slugify(text: str) -> str:
    """Convert a title to a URL-safe, stable slug (unique item key)."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    text = re.sub(r"[-\s]+", "-", text)
    return text or "untitled"


def parse_caption(caption: str | None):
    """Return dict {title, part, total, tags} if caption matches the contract, else None."""
    if not caption:
        return None
    m = CAPTION_RE.match(caption.strip())
    if not m:
        return None
    tags = [t.strip() for t in m.group("tags").split(",") if t.strip()]
    return {
        "title": m.group("title").strip(),
        "part": int(m.group("part")),
        "total": int(m.group("total")),
        "tags": tags,
    }


def detect_kind(message) -> str | None:
    """Return 'media' (has thumbnail) or 'archive' (archive). None if not a file."""
    if message.photo or message.video or message.animation:
        return "media"
    doc = message.document
    if doc:
        mime = doc.mime_type or ""
        if mime.startswith("image/") or mime.startswith("video/"):
            return "media"
        return "archive"  # .7z / .zip / split parts etc.
    return None


def get_file_meta(message):
    """Return (file_name, file_size) for this part."""
    if message.document:
        return message.document.file_name, message.document.file_size or 0
    if message.video:
        return message.video.file_name, message.video.file_size or 0
    if message.animation:
        return message.animation.file_name, message.animation.file_size or 0
    if message.photo:
        return None, message.photo[-1].file_size or 0
    return None, 0


def get_file_id(message) -> str | None:
    """Return the main file_id for this message's media."""
    if message.document:
        return message.document.file_id
    if message.video:
        return message.video.file_id
    if message.animation:
        return message.animation.file_id
    if message.photo:
        return message.photo[-1].file_id
    return None



def derive_media_meta(message):
    """Fallback metadata for MEDIA whose caption doesn't match the contract.

    Always produces a title (never None) so media is never lost.
    Returns (parsed_dict, has_caption); has_caption=True when the title came from
    the actual caption — used so album members WITHOUT a caption don't overwrite
    the title set by the member that HAS one (album update order is not guaranteed).
    """
    caption = message.caption
    tags: list[str] = []
    title = None
    if caption and caption.strip():
        text = caption.strip()
        # Hashtags often appear in forwarded content → treat them as tags.
        tags = [t.lstrip("#") for t in re.findall(r"#\w+", text)]
        # Title = first line without hashtags, trimmed.
        first = re.sub(r"#\w+", "", text.splitlines()[0]).strip(" -|")
        title = first[:120] or None
    has_caption = title is not None
    if not title:
        file_name, _ = get_file_meta(message)
        if file_name:
            title = os.path.splitext(os.path.basename(file_name))[0]
    if not title:
        title = f"Media {message.date:%Y-%m-%d}"
    return {"title": title, "part": 1, "total": 1, "tags": tags}, has_caption


def pick_thumb_file_id(message) -> str | None:
    """Return the file_id of Telegram's built-in thumbnail for a media item."""
    if message.photo:
        # message.photo = list of PhotoSize (small → large). Take the largest one
        # (under the 20 MB get_file limit) for a sharp preview in the web UI.
        return message.photo[-1].file_id
    if message.video and message.video.thumbnail:
        return message.video.thumbnail.file_id
    if message.animation and message.animation.thumbnail:
        return message.animation.thumbnail.file_id
    if message.document and message.document.thumbnail:
        return message.document.thumbnail.file_id
    return None


async def is_user_authorized(db, user_id: int) -> bool:
    if user_id == OWNER_USER_ID:
        return True
    try:
        rs = await db.execute("SELECT 1 FROM authorized_users WHERE user_id = ?", [user_id])
        return len(rs.rows) > 0
    except Exception:
        # If the table doesn't exist yet, fallback to owner-only
        return False


# ---------------------------------------------------------------------------
# Turso operations (idempotent)
# ---------------------------------------------------------------------------
async def resolve_folders(db, folder_path: str) -> int | None:
    parts = [p.strip() for p in folder_path.split("/") if p.strip()]
    if not parts:
        return None
    parent_id = None
    for part in parts:
        rs = await db.execute(
            "SELECT id FROM folders WHERE name = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))",
            [part, parent_id, parent_id]
        )
        if rs.rows:
            parent_id = rs.rows[0][0]
        else:
            await db.execute(
                "INSERT INTO folders (name, parent_id) VALUES (?, ?)",
                [part, parent_id]
            )
            rs = await db.execute(
                "SELECT id FROM folders WHERE name = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))",
                [part, parent_id, parent_id]
            )
            parent_id = rs.rows[0][0]
    return parent_id


async def upsert_item(db, slug, title, kind, total, set_title=True) -> int:
    """Upsert item by slug, return item_id.

    set_title=False → do NOT overwrite an existing title. Used for album members
    without a caption so they don't clobber the title set by a captioned member
    (album update order is not guaranteed).
    """
    original_title = title
    if "/" in original_title:
        title_parts = [p.strip() for p in original_title.split("/")]
        folder_path = "/".join(title_parts[:-1])
        title = title_parts[-1]
        folder_id = await resolve_folders(db, folder_path)
    else:
        folder_id = None

    # Check if the item already exists to protect user modifications
    rs_exist = await db.execute("SELECT title, folder_id FROM items WHERE slug = ?", [slug])
    if rs_exist.rows:
        existing_title = rs_exist.rows[0][0]
        existing_folder_id = rs_exist.rows[0][1]
        
        allow_overwrite = False
        if set_title:
            if existing_title == title:
                allow_overwrite = True
            elif slug.startswith("album-"):
                # Fallbacks for albums: Media YYYY-MM-DD
                if re.match(r"^Media \d{4}-\d{2}-\d{2}$", existing_title):
                    allow_overwrite = True
                else:
                    # Or check if existing title matches any of the parts' base filenames
                    parts_rs = await db.execute(
                        "SELECT file_name FROM parts WHERE item_id = (SELECT id FROM items WHERE slug = ?)", 
                        [slug]
                    )
                    for row in parts_rs.rows:
                        fn = row[0]
                        if fn:
                            base_fn = os.path.splitext(os.path.basename(fn))[0]
                            if existing_title == base_fn:
                                allow_overwrite = True
                                break
        
        if not allow_overwrite:
            title = existing_title
            folder_id = existing_folder_id

    await db.execute(
        """
        INSERT INTO items (slug, title, kind, total_parts, folder_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
            title       = CASE WHEN ? THEN excluded.title ELSE items.title END,
            kind        = excluded.kind,
            total_parts = MAX(items.total_parts, excluded.total_parts),
            folder_id   = CASE WHEN ? THEN excluded.folder_id ELSE items.folder_id END,
            updated_at  = datetime('now')
        """,
        [slug, title, kind, total, folder_id, 1 if set_title else 0, 1 if set_title else 0],
    )
    rs = await db.execute("SELECT id FROM items WHERE slug = ?", [slug])
    return rs.rows[0][0]


async def upsert_part(db, item_id, part_number, channel_msg_id, file_name, file_size, file_id=None) -> int:
    """Upsert part by channel_msg_id (idempotency key & copy_message target). Return part_id."""
    # Check if this part already exists to get its old item_id
    old_item_id = None
    rs_exist = await db.execute("SELECT item_id FROM parts WHERE channel_msg_id = ?", [channel_msg_id])
    if rs_exist.rows:
        old_item_id = rs_exist.rows[0][0]

    await db.execute(
        """
        INSERT INTO parts (item_id, part_number, channel_msg_id,
                           file_name, file_size, file_id, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(channel_msg_id) DO UPDATE SET
            item_id     = excluded.item_id,
            part_number = excluded.part_number,
            file_name   = excluded.file_name,
            file_size   = excluded.file_size,
            file_id     = COALESCE(excluded.file_id, parts.file_id)
        """,
        [item_id, part_number, channel_msg_id, file_name, file_size, file_id],
    )
    rs = await db.execute("SELECT id FROM parts WHERE channel_msg_id = ?", [channel_msg_id])
    part_id = rs.rows[0][0]

    # Clean up old item if the part got reassigned to a different item
    if old_item_id is not None and old_item_id != item_id:
        await recompute_totals(db, old_item_id)
        # Check if the old item has 0 parts left
        rs_count = await db.execute("SELECT COUNT(*) FROM parts WHERE item_id = ?", [old_item_id])
        if rs_count.rows and rs_count.rows[0][0] == 0:
            # Delete from items (foreign keys ON DELETE CASCADE will clean up item_tags, etc.)
            await db.execute("DELETE FROM items WHERE id = ?", [old_item_id])

    return part_id



async def recompute_totals(db, item_id):
    """Sync total_size & total_parts from the existing parts rows."""
    await db.execute(
        """
        UPDATE items SET
            total_size  = (SELECT COALESCE(SUM(file_size), 0) FROM parts WHERE item_id = ?),
            total_parts = MAX(total_parts, (SELECT COUNT(*) FROM parts WHERE item_id = ?)),
            updated_at  = datetime('now')
        WHERE id = ?
        """,
        [item_id, item_id, item_id],
    )


async def sync_tags(db, item_id, tags):
    """Ensure tags exist and are linked to the item (many-to-many)."""
    for name in tags:
        await db.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", [name])
        rs = await db.execute("SELECT id FROM tags WHERE name = ?", [name])
        tag_id = rs.rows[0][0]
        await db.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)",
            [item_id, tag_id],
        )


async def upsert_thumbnail(db, part_id, mime, data_b64):
    await db.execute(
        """
        INSERT INTO thumbnails (part_id, mime, data) VALUES (?, ?, ?)
        ON CONFLICT(part_id) DO UPDATE SET mime = excluded.mime, data = excluded.data
        """,
        [part_id, mime, data_b64],
    )


# ---------------------------------------------------------------------------
# channel_post handler
# ---------------------------------------------------------------------------
async def warn_owner(context, text):
    try:
        await context.bot.send_message(chat_id=OWNER_USER_ID, text=text)
    except Exception:  # noqa: BLE001 — don't let a failed send break the handler
        log.exception("Failed to send warning to owner")


async def on_channel_post(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.channel_post or update.edited_channel_post
    if message is None:
        return

    db = context.bot_data["db"]
    msg_id = message.message_id

    kind = detect_kind(message)
    if kind is None:
        # Plain text post (announcement, etc.) — not a file, ignore.
        return

    parsed = parse_caption(message.caption)
    if parsed is not None:
        has_caption = True
    elif kind == "media":
        # Media doesn't need a structured caption — derive metadata and index anyway.
        parsed, has_caption = derive_media_meta(message)
    else:
        # Multi-part archives REQUIRE a caption (title = grouping key, part/total = assembly order).
        log.warning("Invalid caption on msg %s (archive)", msg_id)
        await warn_owner(
            context,
            "⚠️ Caption does not match the required format — file NOT indexed.\n"
            f"Message: https://t.me/c/{str(STORAGE_CHANNEL_ID)[4:]}/{msg_id}\n"
            f"Caption: {message.caption or '(empty)'}\n\n"
            "Required format: Title | part/total | tag1, tag2",
        )
        return

    title = parsed["title"]
    mgid = message.media_group_id

    if kind == "media" and mgid:
        # ALBUM (media group): all photos/videos in the group → ONE multi-part item.
        # Slug derived from media_group_id for stability even if the captioned message arrives last.
        # part_number = msg_id → unique per item, ordered per album, race-safe across updates.
        slug = f"album-{mgid}"
        part_number = msg_id
    elif kind == "media":
        # Single media: each post = its own item (titles may repeat).
        slug = f"{slugify(title)}-{msg_id}"
        part_number = parsed["part"]
    else:
        # Archive: slug purely from title so parts 1..N are grouped into one item.
        slug = slugify(title)
        part_number = parsed["part"]

    file_name, file_size = get_file_meta(message)
    file_id = get_file_id(message)

    try:
        item_id = await upsert_item(db, slug, title, kind, parsed["total"], set_title=has_caption)
        part_id = await upsert_part(db, item_id, part_number, msg_id, file_name, file_size, file_id)

        await recompute_totals(db, item_id)
        await sync_tags(db, item_id, parsed["tags"])

        # Harvest thumbnail per-part (media only; each photo/video has its own thumbnail).
        if kind == "media":
            await harvest_thumbnail(context, db, part_id, message)

        log.info(
            "Indexed: %s [%s] part %s (item_id=%s, msg=%s)",
            slug, kind, part_number, item_id, msg_id,
        )
    except Exception:  # noqa: BLE001
        log.exception("Failed to index msg %s", msg_id)
        await warn_owner(
            context,
            f"⚠️ Error indexing '{title}' (msg {msg_id}). Check bot logs.",
        )


async def download_file_content(tg_file) -> bytes:
    """Read a local file directly if the path starts with '/' or exists locally,
    otherwise download it to memory (fallback for non-local bot API)."""
    path = tg_file.file_path
    if path and (path.startswith("/") or os.path.exists(path)):
        log.info("Reading local file for thumbnail: %s", path)
        with open(path, "rb") as f:
            return f.read()
    else:
        log.info("Downloading file over HTTP (fallback): %s", path)
        buf = io.BytesIO()
        await tg_file.download_to_memory(out=buf)
        return buf.getvalue()


async def _deferred_harvest(bot, db, part_id: int, channel_msg_id: int):
    """Background task: wait 60 s then re-fetch the message via forwardMessage to get
    the thumbnail Telegram generates asynchronously after the file is processed."""
    await asyncio.sleep(60)
    fwd_msg_id = None
    try:
        fwd = await bot.forward_message(
            chat_id=OWNER_USER_ID,
            from_chat_id=STORAGE_CHANNEL_ID,
            message_id=channel_msg_id,
        )
        fwd_msg_id = fwd.message_id
        file_id = pick_thumb_file_id(fwd)
        if file_id:
            tg_file = await bot.get_file(file_id)
            data_bytes = await download_file_content(tg_file)
            data_b64 = base64.b64encode(data_bytes).decode("ascii")
            await upsert_thumbnail(db, part_id, "image/jpeg", data_b64)
            log.info("Deferred thumbnail harvested for part_id=%s", part_id)
        else:
            log.info("Deferred harvest: still no thumbnail for part_id=%s (unsupported codec?)", part_id)
    except Exception:  # noqa: BLE001
        log.exception("Deferred thumbnail harvest failed for part_id=%s", part_id)
    finally:
        if fwd_msg_id is not None:
            try:
                await bot.delete_message(chat_id=OWNER_USER_ID, message_id=fwd_msg_id)
            except Exception:  # noqa: BLE001
                pass


async def harvest_thumbnail(context, db, part_id, message):
    """Download Telegram's built-in thumbnail for ONE part → base64 → thumbnails table.

    If the thumbnail is not yet available (Telegram generates it asynchronously),
    schedules a deferred retry after 60 s.
    """
    file_id = pick_thumb_file_id(message)
    if not file_id:
        log.info("No thumbnail yet for part_id=%s — scheduling deferred harvest in 60 s", part_id)
        asyncio.create_task(
            _deferred_harvest(context.bot, db, part_id, message.message_id)
        )
        return
    tg_file = await context.bot.get_file(file_id)
    data_bytes = await download_file_content(tg_file)
    data_b64 = base64.b64encode(data_bytes).decode("ascii")
    # Telegram's built-in thumbnails are JPEG.
    await upsert_thumbnail(db, part_id, "image/jpeg", data_b64)


# ---------------------------------------------------------------------------
# /start handler — download via copy_message
# ---------------------------------------------------------------------------
async def on_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if message is None:
        return

    db = context.bot_data["db"]
    # Security: only authorized users may trigger downloads.
    if user is None or not await is_user_authorized(db, user.id):
        await message.reply_text(
            f"⛔ Access denied. This bot is private.\nYour Telegram ID: `{user.id}`\n"
            "Use `/auth <password>` to authorize or ask the owner."
        )
        await warn_owner(
            context,
            f"⚠️ Unauthorized download attempt:\nUser: {user.first_name if user else 'Unknown'} "
            f"(@{user.username if user else 'none'}, ID: `{user.id if user else 'unknown'}`)\n"
            f"To approve: `/approve {user.id}`"
        )
        return

    # Deep link "?start=<slug>" → PTB fills context.args.
    if not context.args:
        await message.reply_text(
            "Hello! Open the dashboard, click ⋮ on an item, then choose Download — "
            "the file will be sent here."
        )
        return

    db = context.bot_data["db"]
    slug = context.args[0]

    rs = await db.execute(
        "SELECT id, title FROM items WHERE slug = ? AND deleted_at IS NULL", [slug]
    )
    if not rs.rows:
        await message.reply_text("Item not found or already deleted.")
        return
    item_id, title = rs.rows[0][0], rs.rows[0][1]

    parts = await db.execute(
        "SELECT channel_msg_id FROM parts WHERE item_id = ? ORDER BY part_number", [item_id]
    )
    if not parts.rows:
        await message.reply_text("This item has no files.")
        return

    total = len(parts.rows)
    await message.reply_text(f'Sending "{title}" ({total} part(s))…')
    for row in parts.rows:
        msg_id = row[0]
        try:
            # copy_message = reference operation (bypasses size limits) & hides the channel.
            await context.bot.copy_message(
                chat_id=user.id, from_chat_id=STORAGE_CHANNEL_ID, message_id=msg_id
            )
        except Exception:  # noqa: BLE001
            log.exception("Failed to copy_message msg %s", msg_id)
        await asyncio.sleep(0.3)  # respect flood limits


# ---------------------------------------------------------------------------
# JobQueue — daily purge of trashed items older than 7 days
# ---------------------------------------------------------------------------
async def bot_heartbeat_job(context: ContextTypes.DEFAULT_TYPE):
    db = context.bot_data.get("db")
    if db is None:
        return
    try:
        await db.execute(
            "INSERT INTO bot_heartbeat (id, last_seen, status) VALUES (1, datetime('now'), 'idle') "
            "ON CONFLICT(id) DO UPDATE SET last_seen=datetime('now'), status=excluded.status",
            [],
        )
    except Exception:  # noqa: BLE001
        log.exception("Failed to write bot heartbeat")


async def purge_job(context: ContextTypes.DEFAULT_TYPE):
    db = context.bot_data["db"]
    rs = await db.execute(
        "SELECT id FROM items "
        "WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', '-7 days')"
    )
    ids = [r[0] for r in rs.rows]
    if not ids:
        return

    purged = 0
    for item_id in ids:
        parts = await db.execute(
            "SELECT channel_msg_id FROM parts WHERE item_id = ?", [item_id]
        )
        for row in parts.rows:
            try:
                await context.bot.delete_message(
                    chat_id=STORAGE_CHANNEL_ID, message_id=row[0]
                )
            except Exception:  # noqa: BLE001 — message may already be deleted
                log.exception("Failed to delete_message msg %s", row[0])
            await asyncio.sleep(0.2)
        # Explicit hard delete (not relying on PRAGMA foreign_keys).
        # thumbnails has a FK to parts → delete thumbnails first.
        await db.execute(
            "DELETE FROM thumbnails WHERE part_id IN (SELECT id FROM parts WHERE item_id = ?)",
            [item_id],
        )
        await db.execute("DELETE FROM parts WHERE item_id = ?", [item_id])
        await db.execute("DELETE FROM item_tags WHERE item_id = ?", [item_id])
        await db.execute("DELETE FROM items WHERE id = ?", [item_id])
        purged += 1

    log.info("Purge complete: %s item(s) permanently deleted", purged)
    try:
        await context.bot.send_message(
            chat_id=OWNER_USER_ID,
            text=f"🧹 Purge: {purged} item(s) permanently deleted from channel & database.",
        )
    except Exception:  # noqa: BLE001
        log.exception("Failed to send purge summary")


# ---------------------------------------------------------------------------
# Turso lifecycle
# ---------------------------------------------------------------------------
async def post_init(app: Application):
    db = libsql_client.create_client(
        url=TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN
    )
    app.bot_data["db"] = db
    log.info("Turso connection ready")

    # Auto-migration: ensure parts table has file_id column
    try:
        await db.execute("ALTER TABLE parts ADD COLUMN file_id TEXT")
        log.info("Migration: Added file_id column to parts table successfully")
    except Exception as e:
        pass

    # Auto-migration: create authorized_users table
    try:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS authorized_users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                added_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        log.info("Migration: Created authorized_users table successfully")
    except Exception as e:
        log.warning("Migration failed for authorized_users: %s", e)

    # Initialize bot_settings table & web_url configuration
    try:
        await db.execute("CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)")
        rs = await db.execute("SELECT value FROM bot_settings WHERE key = 'web_url'")
        if rs.rows:
            app.bot_data["web_url"] = rs.rows[0][0].rstrip("/")
            log.info("Loaded web_url from DB: %s", app.bot_data["web_url"])
        else:
            default_url = os.environ.get("NEXT_PUBLIC_WEB_URL", "http://localhost:3000").rstrip("/")
            app.bot_data["web_url"] = default_url
            await db.execute("INSERT OR IGNORE INTO bot_settings (key, value) VALUES ('web_url', ?)", [default_url])
            log.info("Initialized web_url in DB: %s", default_url)
    except Exception as e:
        log.warning("Failed to initialize bot_settings: %s", e)
        app.bot_data["web_url"] = os.environ.get("NEXT_PUBLIC_WEB_URL", "http://localhost:3000").rstrip("/")

    # Register commands menu with Telegram
    try:
        # Default commands for regular authorized users
        default_commands = [
            BotCommand("menu", "Show bot main menu & commands"),
            BotCommand("start", "Trigger file download / Greet"),
            BotCommand("auth", "Authorize yourself using password"),
            BotCommand("cancel", "Cancel current file upload flow"),
        ]
        await app.bot.set_my_commands(default_commands, scope=BotCommandScopeDefault())
        
        # Admin/Owner commands (only visible in chat with OWNER_USER_ID)
        owner_commands = [
            BotCommand("menu", "Show bot main menu & commands"),
            BotCommand("start", "Trigger file download / Greet"),
            BotCommand("cancel", "Cancel current file upload flow"),
            BotCommand("approve", "Authorize a user: /approve <user_id>"),
            BotCommand("revoke", "Revoke authorization: /revoke <user_id>"),
            BotCommand("list_users", "List all authorized users"),
            BotCommand("set_web_url", "Set web dashboard URL"),
        ]
        await app.bot.set_my_commands(owner_commands, scope=BotCommandScopeChat(chat_id=OWNER_USER_ID))
        
        log.info("Bot commands menu registered successfully for default and owner scopes")
    except Exception as e:
        log.warning("Failed to set bot commands: %s", e)



async def post_shutdown(app: Application):
    db = app.bot_data.get("db")
    if db is not None:
        await db.close()
        log.info("Turso connection closed")


# ---------------------------------------------------------------------------
# Authorization commands
# ---------------------------------------------------------------------------
async def on_auth(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if not message or not user:
        return

    db = context.bot_data["db"]

    # If already authorized
    if await is_user_authorized(db, user.id):
        await message.reply_text("✅ You are already authorized to use this bot.")
        return

    if not context.args:
        await message.reply_text(
            "Usage: <code>/auth &lt;password&gt;</code>\n\n"
            "If you don't know the password, please contact the bot owner.",
            parse_mode="HTML"
        )
        return

    password = context.args[0]
    auth_password = os.environ.get("AUTH_PASSWORD") or os.environ.get("APP_PASSWORD")

    if not auth_password:
        await message.reply_text("⚠️ No authentication password is configured on the server. Please contact the owner.")
        return

    if password == auth_password:
        try:
            await db.execute(
                "INSERT OR IGNORE INTO authorized_users (user_id, username, first_name) VALUES (?, ?, ?)",
                [user.id, user.username, user.first_name]
            )
            await message.reply_text("🎉 Authorization successful! You can now use the bot.")
            await warn_owner(
                context,
                f"🔑 User {user.first_name} (@{user.username or 'none'}, ID: `{user.id}`) has successfully authorized using the password."
            )
        except Exception as e:
            log.exception("Failed to authorize user in DB")
            await message.reply_text("❌ Database error during authorization. Please try again later.")
    else:
        await message.reply_text("❌ Incorrect password. Access denied.")


async def on_approve(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if not message or not user:
        return

    if user.id != OWNER_USER_ID:
        await message.reply_text("⛔ Only the owner can approve users.")
        return

    if not context.args:
        await message.reply_text("Usage: <code>/approve &lt;user_id&gt;</code>", parse_mode="HTML")
        return

    try:
        target_id = int(context.args[0])
    except ValueError:
        await message.reply_text("❌ Invalid user ID. Must be an integer.")
        return

    db = context.bot_data["db"]
    try:
        await db.execute(
            "INSERT OR IGNORE INTO authorized_users (user_id, username, first_name) VALUES (?, ?, ?)",
            [target_id, "Approved by Owner", "User"]
        )
        await message.reply_text(f"✅ User {target_id} has been authorized.")
        
        try:
            await context.bot.send_message(
                chat_id=target_id,
                text="🎉 You have been authorized by the owner to use this bot!"
            )
        except Exception:
            pass  # User might not have started a chat with the bot
    except Exception as e:
        log.exception("Failed to approve user")
        await message.reply_text(f"❌ Error approving user: {e}")


async def on_revoke(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if not message or not user:
        return

    if user.id != OWNER_USER_ID:
        await message.reply_text("⛔ Only the owner can revoke users.")
        return

    if not context.args:
        await message.reply_text("Usage: <code>/revoke &lt;user_id&gt;</code>", parse_mode="HTML")
        return

    try:
        target_id = int(context.args[0])
    except ValueError:
        await message.reply_text("❌ Invalid user ID. Must be an integer.")
        return

    db = context.bot_data["db"]
    try:
        await db.execute("DELETE FROM authorized_users WHERE user_id = ?", [target_id])
        await message.reply_text(f"✅ User {target_id} authorization has been revoked.")
        
        try:
            await context.bot.send_message(
                chat_id=target_id,
                text="🚫 Your authorization to use this bot has been revoked by the owner."
            )
        except Exception:
            pass
    except Exception as e:
        log.exception("Failed to revoke user")
        await message.reply_text(f"❌ Error revoking user: {e}")


async def on_list_users(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if not message or not user:
        return

    if user.id != OWNER_USER_ID:
        await message.reply_text("⛔ Only the owner can list authorized users.")
        return

    db = context.bot_data["db"]
    try:
        rs = await db.execute("SELECT user_id, username, first_name, added_at FROM authorized_users")
        if not rs.rows:
            await message.reply_text("No other users authorized yet.")
            return

        text = "👤 <b>Authorized Users:</b>\n"
        for r in rs.rows:
            username = f"@{html.escape(r[1])}" if r[1] else "none"
            text += f"- {html.escape(r[2])} ({username}, ID: <code>{r[0]}</code>), added on {html.escape(str(r[3]))}\n"
        await message.reply_text(text, parse_mode="HTML")
    except Exception as e:
        log.exception("Failed to list users")
        await message.reply_text(f"❌ Error reading users: {e}")


async def on_set_web_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if not message or not user:
        return

    if user.id != OWNER_USER_ID:
        await message.reply_text("⛔ Only the owner can change the web URL.")
        return

    if not context.args:
        current_url = context.bot_data.get("web_url", "http://localhost:3000")
        await message.reply_text(
            f"🌐 Current web dashboard URL is: <code>{html.escape(current_url)}</code>\n\n"
            "To change it, use:\n"
            "<code>/set_web_url &lt;new_url&gt;</code>",
            parse_mode="HTML"
        )
        return

    new_url = context.args[0].strip().rstrip("/")
    if not (new_url.startswith("http://") or new_url.startswith("https://")):
        await message.reply_text("❌ Invalid URL. Must start with http:// or https://")
        return

    db = context.bot_data["db"]
    try:
        await db.execute(
            "INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('web_url', ?)",
            [new_url]
        )
        context.bot_data["web_url"] = new_url
        await message.reply_text(f"✅ Web dashboard URL successfully updated to:\n<code>{html.escape(new_url)}</code>", parse_mode="HTML")
        log.info("Owner updated web_url to: %s", new_url)
    except Exception as e:
        log.exception("Failed to update web_url in DB")
        await message.reply_text(f"❌ Database error: {e}")


# ---------------------------------------------------------------------------
# Menu / Help Command
# ---------------------------------------------------------------------------
async def send_main_menu(update: Update, context: ContextTypes.DEFAULT_TYPE, edit: bool = False):
    user = update.effective_user
    message = update.message or (update.callback_query.message if update.callback_query else None)
    if not user or not message:
        return

    db = context.bot_data["db"]
    is_auth = await is_user_authorized(db, user.id)
    is_owner = (user.id == OWNER_USER_ID)
    web_url = context.bot_data.get("web_url", "http://localhost:3000")

    if not is_auth:
        text = (
            "🤖 <b>Telegram Cloud Drive Bot</b>\n\n"
            "🔒 You are currently <b>NOT authorized</b> to use this bot.\n\n"
            "To authorize, please type:\n"
            "<code>/auth &lt;password&gt;</code>\n\n"
            "Or ask the owner to approve your Telegram ID."
        )
        keyboard = [
            [InlineKeyboardButton("🔑 Get My Telegram ID", callback_data="menu:get_id")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        if edit and update.callback_query:
            await update.callback_query.edit_message_text(text, reply_markup=reply_markup, parse_mode="HTML")
        else:
            await context.bot.send_message(chat_id=message.chat_id, text=text, reply_markup=reply_markup, parse_mode="HTML")
        return

    text = (
        "🤖 <b>Telegram Cloud Drive Bot Menu</b>\n\n"
        "Welcome! Select an option below to interact with the cloud drive:"
    )

    keyboard = [
        [
            InlineKeyboardButton("📥 How to Upload", callback_data="menu:upload_guide"),
            InlineKeyboardButton("👤 My Auth Info", callback_data="menu:auth_info")
        ],
        [
            InlineKeyboardButton("🌐 Open Web Dashboard", url=web_url)
        ]
    ]

    if is_owner:
        keyboard.append([InlineKeyboardButton("👑 Admin Panel", callback_data="menu:admin_menu")])

    reply_markup = InlineKeyboardMarkup(keyboard)

    if edit and update.callback_query:
        await update.callback_query.edit_message_text(text, reply_markup=reply_markup, parse_mode="HTML")
    else:
        await context.bot.send_message(chat_id=message.chat_id, text=text, reply_markup=reply_markup, parse_mode="HTML")


async def on_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await send_main_menu(update, context, edit=False)


# ---------------------------------------------------------------------------
# Cancel upload flow
# ---------------------------------------------------------------------------
async def on_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if not message or not user:
        return

    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        return

    if "upload_file" in context.user_data or "upload_state" in context.user_data or "upload_queue" in context.user_data:
        context.user_data.pop("upload_file", None)
        context.user_data.pop("upload_state", None)
        context.user_data.pop("upload_queue", None)
        await message.reply_text("❌ Upload flow and queue cancelled.")
    else:
        await message.reply_text("There is no active upload flow to cancel.")


# ---------------------------------------------------------------------------
# Helper to process next file in the upload queue
# ---------------------------------------------------------------------------
async def process_next_in_queue(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Clear current state first
    context.user_data.pop("upload_file", None)
    context.user_data.pop("upload_state", None)

    queue = context.user_data.get("upload_queue", [])
    if not queue:
        return

    # Pop next item
    next_file = queue.pop(0)
    context.user_data["upload_file"] = next_file
    context.user_data["upload_state"] = "WAITING_TITLE"

    msg_id = next_file["message_ids"][0]
    chat_id = next_file["chat_id"]
    web_url = context.bot_data.get("web_url", "http://localhost:3000")
    file_name = next_file["file_name"]
    file_size = next_file["file_size"]
    auto_title = next_file["auto_title"]

    try:
        btn_title = auto_title
        if len(btn_title) > 40:
            btn_title = btn_title[:37] + "..."

        link = f"{web_url}/upload-bot?msg_id={msg_id}&chat_id={chat_id}"

        keyboard = [
            [InlineKeyboardButton(f"✨ Use Auto Title: {btn_title}", callback_data="upload:skip_title")],
            [InlineKeyboardButton("❌ Cancel", callback_data="upload:cancel")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)

        num_files = len(next_file["message_ids"])
        files_info = f"• Total Files: <code>{num_files}</code>\n" if num_files > 1 else f"• File Name: <code>{html.escape(file_name or 'Photo/Media')}</code>\n"

        # Send to chat
        await context.bot.send_message(
            chat_id=chat_id,
            text=f"📥 <b>Next File in Queue!</b>\n"
                 f"{files_info}"
                 f"• Total Size: <code>{file_size / 1024 / 1024:.2f} MB</code>\n\n"
                 f"Please reply with a <b>Title</b> for this upload.\n"
                 f"Or click the button below to use the Auto Title.\n\n"
                 f"🔗 Alternatively, you can complete the details via the <a href=\"{link}\">web</a>!",
            reply_markup=reply_markup,
            parse_mode="HTML",
            disable_web_page_preview=True
        )
    except Exception as e:
        log.exception("Failed to start next upload flow questionnaire from queue")
        # If this next item failed to display, clean up and try the next one recursively
        await process_next_in_queue(update, context)


# ---------------------------------------------------------------------------
# Private chat handler (Bot Drop & File Upload Flow)
# ---------------------------------------------------------------------------
async def on_private_file(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if not message or not user:
        return

    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        await message.reply_text(
            f"⛔ Access denied. You are not authorized.\nYour Telegram ID: `{user.id}`\n"
            "Use `/auth <password>` to authorize or ask the owner."
        )
        await warn_owner(
            context,
            f"⚠️ Unauthorized upload attempt:\nUser: {user.first_name} (@{user.username or 'none'}, ID: `{user.id}`)\n"
            f"To approve: `/approve {user.id}`"
        )
        return

    kind = detect_kind(message)
    if not kind:
        # Not a media/document message
        return

    file_name, file_size = get_file_meta(message)
    auto_meta, _ = derive_media_meta(message)

    # Check if the file already has a valid caption contract matching Title | part/total | tags
    caption_meta = parse_caption(message.caption)
    if caption_meta:
        title = caption_meta["title"]
        part = caption_meta["part"]
        total = caption_meta["total"]
        tags_str = ", ".join(caption_meta["tags"])
        
        status_msg = await context.bot.send_message(
            chat_id=message.chat_id,
            text="📤 Copying file directly to storage channel..."
        )
        try:
            copied_msg = await context.bot.copy_message(
                chat_id=STORAGE_CHANNEL_ID,
                from_chat_id=message.chat_id,
                message_id=message.message_id,
                caption=message.caption
            )
            await status_msg.edit_text(
                f"🎉 <b>Success!</b>\n\n"
                f"File has been successfully uploaded and indexed directly via caption contract.\n"
                f"• <b>Title</b>: <code>{html.escape(title)}</code>\n"
                f"• <b>Part</b>: {part}/{total}\n"
                f"• <b>Tags</b>: <code>{html.escape(tags_str if tags_str else 'none')}</code>\n\n"
                f"It is now being indexed and will appear on the website shortly!",
                parse_mode="HTML"
            )
        except Exception as e:
            log.exception("Failed to copy user file to channel directly")
            await status_msg.edit_text(
                f"❌ <b>Error copying file:</b> {html.escape(str(e))}\n"
                "Please check bot configuration and try again.",
                parse_mode="HTML"
            )
        return

    active_upload = context.user_data.get("upload_file")
    if active_upload:
        # Check if this belongs to the active upload flow (same media group)
        if message.media_group_id and active_upload.get("media_group_id") == message.media_group_id:
            active_upload["message_ids"].append(message.message_id)
            if file_size:
                active_upload["file_size"] += file_size
            return

        # Check if this belongs to an item already in the queue
        if "upload_queue" not in context.user_data:
            context.user_data["upload_queue"] = []

        if message.media_group_id:
            for item in context.user_data["upload_queue"]:
                if item.get("media_group_id") == message.media_group_id:
                    item["message_ids"].append(message.message_id)
                    if file_size:
                        item["file_size"] += file_size
                    return

        # Otherwise, add it as a new item in the queue
        queue_item = {
            "message_ids": [message.message_id],
            "media_group_id": message.media_group_id,
            "chat_id": message.chat_id,
            "kind": kind,
            "file_name": file_name,
            "file_size": file_size,
            "auto_title": auto_meta["title"],
            "auto_tags": auto_meta["tags"],
        }
        context.user_data["upload_queue"].append(queue_item)
        pos = len(context.user_data["upload_queue"])

        await message.reply_text(
            f"📥 <b>Added to Queue (Position #{pos})</b>\n"
            f"• File Name: <code>{html.escape(file_name or 'Photo/Media')}</code>\n"
            f"• File Size: <code>{file_size / 1024 / 1024:.2f} MB</code>\n\n"
            f"This file will be processed once the active upload flow completes.",
            parse_mode="HTML"
        )
        return

    msg_id = message.message_id
    chat_id = message.chat_id
    web_url = context.bot_data.get("web_url", "http://localhost:3000")
    auto_title = auto_meta["title"]
    auto_tags = auto_meta["tags"]

    context.user_data["upload_file"] = {
        "message_ids": [msg_id],
        "media_group_id": message.media_group_id,
        "chat_id": chat_id,
        "kind": kind,
        "file_name": file_name,
        "file_size": file_size,
        "auto_title": auto_title,
        "auto_tags": auto_tags,
    }
    context.user_data["upload_state"] = "WAITING_TITLE"

    try:
        # Limit button text length to prevent Telegram API errors (e.g. if auto_title is too long)
        btn_title = auto_title
        if len(btn_title) > 40:
            btn_title = btn_title[:37] + "..."

        link = f"{web_url}/upload-bot?msg_id={msg_id}&chat_id={chat_id}"

        # Inline Keyboard for Title selection
        keyboard = [
            [InlineKeyboardButton(f"✨ Use Auto Title: {btn_title}", callback_data="upload:skip_title")],
            [InlineKeyboardButton("❌ Cancel", callback_data="upload:cancel")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)

        # Detect if the file was forwarded or copied from another message
        is_forward = bool(getattr(message, "forward_origin", None) or getattr(message, "forward_date", None))
        source_label = "Forwarded/Copied Album" if message.media_group_id else ("Forwarded/Copied File" if is_forward else "File")

        await message.reply_text(
            f"📥 <b>{source_label} Received!</b>\n"
            f"• File Name: <code>{html.escape(file_name or 'Photo/Media')}</code>\n"
            f"• File Size: <code>{file_size / 1024 / 1024:.2f} MB</code>\n\n"
            f"Please reply with a <b>Title</b> for this upload.\n"
            f"Or click the button below to use the Auto Title.\n\n"
            f"🔗 Alternatively, you can complete the details via the <a href=\"{link}\">web</a>!",
            reply_markup=reply_markup,
            parse_mode="HTML",
            disable_web_page_preview=True
        )
    except Exception as e:
        log.exception("Failed to start upload flow questionnaire")
        await message.reply_text(
            f"❌ <b>Error processing file:</b> {html.escape(str(e))}\n"
            "Please try again or check the logs.",
            parse_mode="HTML"
        )
        await process_next_in_queue(update, context)


async def prompt_for_tags(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["upload_state"] = "WAITING_TAGS"
    auto_tags = context.user_data["upload_file"]["auto_tags"]
    auto_tags_str = ", ".join(auto_tags) if auto_tags else "none"

    try:
        btn_tags = auto_tags_str
        if len(btn_tags) > 40:
            btn_tags = btn_tags[:37] + "..."

        keyboard = [
            [InlineKeyboardButton(f"✨ Use Auto Tags: {btn_tags}", callback_data="upload:skip_tags")],
            [InlineKeyboardButton("❌ Cancel", callback_data="upload:cancel")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)

        message = update.message or update.callback_query.message
        await context.bot.send_message(
            chat_id=message.chat_id,
            text="🏷️ <b>Title set!</b>\n\nWhat are the <b>Tags</b> for this file? (Separate with commas, e.g. <code>holiday, video</code>)\n"
                 "Or click the button below to use the Auto Tags.",
            reply_markup=reply_markup,
            parse_mode="HTML"
        )
    except Exception as e:
        log.exception("Failed to prompt for tags")
        message = update.message or update.callback_query.message
        await context.bot.send_message(
            chat_id=message.chat_id,
            text=f"❌ <b>Error prompting for tags:</b> {html.escape(str(e))}",
            parse_mode="HTML"
        )
        await process_next_in_queue(update, context)


async def finish_upload(update: Update, context: ContextTypes.DEFAULT_TYPE):
    upload_file = context.user_data.get("upload_file")
    if not upload_file:
        return

    title = upload_file.get("title") or upload_file.get("auto_title")
    tags = upload_file.get("tags") or upload_file.get("auto_tags") or []
    tags_str = ", ".join(tags)

    chat_id = upload_file["chat_id"]
    message_ids = upload_file["message_ids"]
    total_parts = len(message_ids)

    # Send status message
    status_msg = await context.bot.send_message(
        chat_id=chat_id,
        text="📤 Copying files to storage channel..."
    )

    try:
        if total_parts == 1:
            caption = f"{title} | 1/1 | {tags_str}"
            copied_msg = await context.bot.copy_message(
                chat_id=STORAGE_CHANNEL_ID,
                from_chat_id=chat_id,
                message_id=message_ids[0],
                caption=caption
            )
        else:
            # Copy all messages as a media group to preserve their grouping in the channel
            copied_messages = await context.bot.copy_messages(
                chat_id=STORAGE_CHANNEL_ID,
                from_chat_id=chat_id,
                message_ids=message_ids
            )
            # Edit the caption of the first copied message to set the contract caption
            first_copied_msg_id = copied_messages[0].message_id
            caption = f"{title} | 1/{total_parts} | {tags_str}"
            await context.bot.edit_message_caption(
                chat_id=STORAGE_CHANNEL_ID,
                message_id=first_copied_msg_id,
                caption=caption
            )

        await status_msg.edit_text(
            f"🎉 <b>Success!</b>\n\n"
            f"All {total_parts} file(s) have been successfully uploaded and indexed.\n"
            f"• <b>Title</b>: <code>{html.escape(title)}</code>\n"
            f"• <b>Tags</b>: <code>{html.escape(tags_str if tags_str else 'none')}</code>\n\n"
            f"They are now being indexed and will appear on the website shortly!",
            parse_mode="HTML"
        )
    except Exception as e:
        log.exception("Failed to copy user files to channel")
        await status_msg.edit_text(
            f"❌ <b>Error copying files:</b> {html.escape(str(e))}\n"
            "Please check bot configuration and try again.",
            parse_mode="HTML"
        )
    finally:
        # Check queue
        await process_next_in_queue(update, context)


async def on_private_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.message
    user = update.effective_user
    if not message or not user:
        return

    db = context.bot_data["db"]
    if not await is_user_authorized(db, user.id):
        return

    state = context.user_data.get("upload_state")
    if not state:
        if message.text and not message.text.startswith("/"):
            await message.reply_text(
                "Send a file (Photo, Video, or Document) to upload it to the cloud drive!"
            )
        return

    text = message.text.strip()
    if text.startswith("/"):
        # Let CommandHandlers handle commands
        return

    if state == "WAITING_TITLE":
        context.user_data["upload_file"]["title"] = text
        await prompt_for_tags(update, context)

    elif state == "WAITING_TAGS":
        tags = [t.strip() for t in text.split(",") if t.strip()]
        context.user_data["upload_file"]["tags"] = tags
        await finish_upload(update, context)


async def on_callback_query(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    data = query.data
    user = update.effective_user
    if not data or not user:
        return

    db = context.bot_data["db"]
    
    # Check menu:get_id which can be triggered by unauthorized users
    if data == "menu:get_id":
        await query.message.reply_text(f"👤 Your Telegram ID is: <code>{user.id}</code>", parse_mode="HTML")
        return

    if not await is_user_authorized(db, user.id):
        await query.message.reply_text("⛔ Access denied.")
        return

    if data == "upload:cancel":
        context.user_data.pop("upload_file", None)
        context.user_data.pop("upload_state", None)
        context.user_data.pop("upload_queue", None)
        await query.message.edit_text("❌ Upload flow and queue cancelled.")

    elif data == "upload:skip_title":
        upload_file = context.user_data.get("upload_file")
        if not upload_file:
            await query.message.edit_text("No active upload flow found.")
            return
        upload_file["title"] = upload_file["auto_title"]
        await prompt_for_tags(update, context)

    elif data == "upload:skip_tags":
        upload_file = context.user_data.get("upload_file")
        if not upload_file:
            await query.message.edit_text("No active upload flow found.")
            return
        upload_file["tags"] = upload_file["auto_tags"]
        await finish_upload(update, context)

    elif data == "menu:main":
        await send_main_menu(update, context, edit=True)

    elif data == "menu:upload_guide":
        text = (
            "📥 <b>How to Upload Files:</b>\n\n"
            "1. Send or <b>forward</b> any file (video, photo, document, animation) directly to this private chat.\n"
            "2. The bot will ask you for a <b>Title</b> (suggesting a derived title from filename or caption).\n"
            "3. The bot will ask you for <b>Tags</b> (optional).\n"
            "4. The bot will automatically format the caption contract and copy the file to the storage channel, indexing it instantly into the website.\n\n"
            "⚠️ Use <code>/cancel</code> if you need to abort an active upload questionnaire."
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back to Menu", callback_data="menu:main")]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="HTML")

    elif data == "menu:auth_info":
        text = (
            "👤 <b>Your Authorization Info:</b>\n\n"
            f"• <b>Telegram ID</b>: <code>{user.id}</code>\n"
            f"• <b>Username</b>: <code>@{html.escape(user.username or 'none')}</code>\n"
            f"• <b>First Name</b>: <code>{html.escape(user.first_name or '')}</code>\n"
            "• <b>Status</b>: ✅ Authorized\n\n"
            "You have full access to download and upload features."
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back to Menu", callback_data="menu:main")]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="HTML")

    elif data == "menu:admin_menu":
        if user.id != OWNER_USER_ID:
            await query.message.reply_text("⛔ Access denied.")
            return
        text = (
            "👑 <b>Owner Admin Panel</b>\n\n"
            "Manage users and bot access control:"
        )
        keyboard = [
            [InlineKeyboardButton("👥 List Users", callback_data="admin:list_users")],
            [
                InlineKeyboardButton("➕ Approve User Info", callback_data="admin:approve_info"),
                InlineKeyboardButton("➖ Revoke User Info", callback_data="admin:revoke_info")
            ],
            [InlineKeyboardButton("⬅️ Back to Menu", callback_data="menu:main")]
        ]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="HTML")

    elif data == "admin:approve_info":
        if user.id != OWNER_USER_ID:
            return
        text = (
            "➕ <b>How to Approve a User:</b>\n\n"
            "To authorize a user, send the command:\n"
            "<code>/approve &lt;user_id&gt;</code>\n\n"
            "Example:\n"
            "<code>/approve 123456789</code>\n\n"
            "The user will receive an automatic notification once approved."
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back to Admin Panel", callback_data="menu:admin_menu")]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="HTML")

    elif data == "admin:revoke_info":
        if user.id != OWNER_USER_ID:
            return
        text = (
            "➖ <b>How to Revoke a User:</b>\n\n"
            "To revoke user access, send the command:\n"
            "<code>/revoke &lt;user_id&gt;</code>\n\n"
            "Example:\n"
            "<code>/revoke 123456789</code>"
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back to Admin Panel", callback_data="menu:admin_menu")]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="HTML")

    elif data == "admin:list_users":
        if user.id != OWNER_USER_ID:
            return
        rs = await db.execute("SELECT user_id, username, first_name, added_at FROM authorized_users")
        if not rs.rows:
            text = "👥 <b>Authorized Users:</b>\n\nNo other users authorized yet."
        else:
            text = "👥 <b>Authorized Users:</b>\n\n"
            for r in rs.rows:
                username = f"@{html.escape(r[1])}" if r[1] else "none"
                text += f"- {html.escape(r[2])} ({username}, ID: <code>{r[0]}</code>), added on {html.escape(str(r[3]))}\n"
        
        keyboard = [
            [InlineKeyboardButton("⬅️ Back to Admin Panel", callback_data="menu:admin_menu")],
            [InlineKeyboardButton("⬅️ Back to Menu", callback_data="menu:main")]
        ]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="HTML")


def main():
    if TELEGRAM_API_URL:
        # Log out from the public Telegram API server if needed, so we can connect to the local server.
        # This is a safe operation as it is a no-op if already logged out.
        try:
            log.info("Attempting to log out bot from public Telegram API server...")
            resp = httpx.post(f"https://api.telegram.org/bot{BOT_TOKEN}/logOut", timeout=10.0)
            log.info("Public API logout status: %s", resp.text)
        except Exception as e:
            log.warning("Failed to log out from public API (normal if already logged out or offline): %s", e)

    builder = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .post_shutdown(post_shutdown)
    )

    if TELEGRAM_API_URL:
        log.info("Configuring bot to use local Telegram Bot API server at: %s", TELEGRAM_API_URL)
        builder = (
            builder.base_url(f"{TELEGRAM_API_URL}/bot")
            .base_file_url(f"{TELEGRAM_API_URL}/file/bot")
            .local_mode(True)
            .http_version("1.1")
            .get_updates_http_version("1.1")
        )

    app = builder.build()

    # Command handlers
    app.add_handler(CommandHandler("start", on_start))
    app.add_handler(CommandHandler("auth", on_auth))
    app.add_handler(CommandHandler("approve", on_approve))
    app.add_handler(CommandHandler("revoke", on_revoke))
    app.add_handler(CommandHandler("list_users", on_list_users))
    app.add_handler(CommandHandler("set_web_url", on_set_web_url))
    app.add_handler(CommandHandler("cancel", on_cancel))
    app.add_handler(CommandHandler("menu", on_menu))

    # Callback Query handler for inline buttons
    app.add_handler(CallbackQueryHandler(on_callback_query))

    # Private text handler for upload details (Title / Tags input)
    app.add_handler(
        MessageHandler(
            filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND,
            on_private_text,
        )
    )

    # Bot Drop / File Upload handler (receives files in the bot's private chat)
    app.add_handler(
        MessageHandler(
            filters.ChatType.PRIVATE & (filters.Document.ALL | filters.VIDEO | filters.PHOTO | filters.ANIMATION),
            on_private_file,
        )
    )

    # Process channel_post and edited_channel_post from STORAGE_CHANNEL_ID.
    app.add_handler(
        MessageHandler(
            filters.Chat(STORAGE_CHANNEL_ID) & (filters.UpdateType.CHANNEL_POST | filters.UpdateType.EDITED_CHANNEL_POST),
            on_channel_post,
        )
    )

    # Heartbeat: write to bot_heartbeat every 10 s so the web UI knows the bot is alive.
    app.job_queue.run_repeating(bot_heartbeat_job, interval=10, first=5)

    # Daily purge of trashed items older than 7 days (03:00 UTC).
    app.job_queue.run_daily(purge_job, time=dtime(hour=3, minute=0))

    log.info("Bot starting polling…")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
