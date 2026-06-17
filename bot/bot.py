"""
Telegram Cloud Drive — bot indexer.

Milestone 2 (+ album & media-fallback): channel_post handler.
Flow: every new file posted to STORAGE_CHANNEL_ID → parse caption
(contract: "Title | part/total | tag1, tag2") → upsert into Turso (items + parts + tags).
- GAME : caption REQUIRED (title = grouping key, part/total = assembly order). Invalid →
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
import io
import logging
import os
import re
import unicodedata
from datetime import time as dtime

import httpx
import libsql_client
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
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
    """Return 'media' (has thumbnail) or 'game' (archive). None if not a file."""
    if message.photo or message.video or message.animation:
        return "media"
    doc = message.document
    if doc:
        mime = doc.mime_type or ""
        if mime.startswith("image/") or mime.startswith("video/"):
            return "media"
        return "game"  # .7z / .zip / split parts etc.
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


# ---------------------------------------------------------------------------
# Turso operations (idempotent)
# ---------------------------------------------------------------------------
async def upsert_item(db, slug, title, kind, total, set_title=True) -> int:
    """Upsert item by slug, return item_id.

    set_title=False → do NOT overwrite an existing title. Used for album members
    without a caption so they don't clobber the title set by a captioned member
    (album update order is not guaranteed).
    """
    await db.execute(
        """
        INSERT INTO items (slug, title, kind, total_parts)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
            title       = CASE WHEN ? THEN excluded.title ELSE items.title END,
            kind        = excluded.kind,
            total_parts = MAX(items.total_parts, excluded.total_parts),
            updated_at  = datetime('now')
        """,
        [slug, title, kind, total, 1 if set_title else 0],
    )
    rs = await db.execute("SELECT id FROM items WHERE slug = ?", [slug])
    return rs.rows[0][0]


async def upsert_part(db, item_id, part_number, channel_msg_id, file_name, file_size, file_id=None) -> int:
    """Upsert part by channel_msg_id (idempotency key & copy_message target). Return part_id."""
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
    return rs.rows[0][0]



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
    message = update.channel_post
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
        # Multi-part games REQUIRE a caption (title = grouping key, part/total = assembly order).
        log.warning("Invalid caption on msg %s (game)", msg_id)
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
        # Game: slug purely from title so parts 1..N are grouped into one item.
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
            buf = io.BytesIO()
            await tg_file.download_to_memory(out=buf)
            data_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
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
    buf = io.BytesIO()
    await tg_file.download_to_memory(out=buf)
    data_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    # Telegram's built-in thumbnails are JPEG.
    await upsert_thumbnail(db, part_id, "image/jpeg", data_b64)


# ---------------------------------------------------------------------------
# /start handler — download via copy_message (owner-only)
# ---------------------------------------------------------------------------
async def on_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if message is None:
        return

    # Security: only the owner may trigger downloads.
    if user is None or user.id != OWNER_USER_ID:
        await message.reply_text("⛔ Access denied. This bot is private.")
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
        # Ignore errors if the column already exists
        pass



async def post_shutdown(app: Application):
    db = app.bot_data.get("db")
    if db is not None:
        await db.close()
        log.info("Turso connection closed")


# ---------------------------------------------------------------------------
# Private chat handler (Bot Drop)
# ---------------------------------------------------------------------------
async def on_private_file(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if not message or not user or user.id != OWNER_USER_ID:
        return

    kind = detect_kind(message)
    if not kind:
        # Not a media/document message
        return

    msg_id = message.message_id
    chat_id = message.chat_id
    web_url = os.environ.get("NEXT_PUBLIC_WEB_URL", "http://localhost:3000").rstrip("/")

    link = f"{web_url}/upload-bot?msg_id={msg_id}&chat_id={chat_id}"

    await message.reply_text(
        f"✅ File received!\n\nClick the link below to complete the file details (Title & Tags) via the web. "
        f"The bot will automatically forward it to the Channel once saved.\n\n👉 {link}",
        disable_web_page_preview=True
    )


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

    # /start (download, owner-only) — private chat.
    app.add_handler(CommandHandler("start", on_start))

    # Bot Drop handler (receives files in the bot's private chat)
    app.add_handler(
        MessageHandler(
            filters.ChatType.PRIVATE & (filters.Document.ALL | filters.VIDEO | filters.PHOTO | filters.ANIMATION),
            on_private_file,
        )
    )

    # Only process channel_post from STORAGE_CHANNEL_ID.
    app.add_handler(
        MessageHandler(
            filters.Chat(STORAGE_CHANNEL_ID) & filters.UpdateType.CHANNEL_POST,
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
