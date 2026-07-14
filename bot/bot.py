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
import html
import os
from datetime import time as dtime

import httpx
from pg_db import create_client
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, BotCommand, BotCommandScopeChat, BotCommandScopeDefault, ForceReply
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
    CallbackQueryHandler,
)

# Config/logging, pure helpers, Turso ops, and channel indexing now live in dedicated
# modules. bot.py keeps the interactive handlers (auth, menu, Bot Drop flow), the purge
# job, lifecycle, and main() wiring. The names below are re-exported so the existing
# `from bot import ...` in index_history.py keeps working unchanged.
from bot_config import (  # noqa: F401  (re-exported for index_history.py)
    BOT_TOKEN,
    STORAGE_CHANNEL_ID,
    OWNER_USER_ID,
    TELEGRAM_API_URL,
    DATABASE_URL,
    log,
)
from tg_helpers import (  # noqa: F401  (re-exported)
    slugify,
    parse_caption,
    detect_kind,
    get_file_meta,
    get_file_id,
    derive_media_meta,
    pick_thumb_file_id,
    encode_thumbnail,
)
from db_ops import (  # noqa: F401  (re-exported)
    is_user_authorized,
    resolve_folders,
    upsert_item,
    upsert_part,
    recompute_totals,
    sync_tags,
    sync_album_tags,
    split_media_albums,
    upsert_thumbnail,
)
from indexing import (  # noqa: F401  (re-exported)
    warn_owner,
    on_channel_post,
    download_file_content,
    _deferred_harvest,
    harvest_thumbnail,
    index_bot_copy,
)
from db_backup import run_backup
from pikpak import (  # noqa: F401  (remote-download feature: PikPak + WebDAV drives via OpenList)
    on_pikpak,
    on_jobs,
    on_ls,
    on_baidu,
    on_baidu_ls,
    start_download as pikpak_start_download,
    do_ls as pikpak_do_ls,
    jobs_text as pikpak_jobs_text,
    render_browser as pikpak_render_browser,
    browse_navigate as pikpak_browse_navigate,
    ensure_schema as ensure_pikpak_schema,
    start_workers as start_pikpak_workers,
)


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



async def purge_job(context: ContextTypes.DEFAULT_TYPE):
    db = context.bot_data["db"]
    rs = await db.execute(
        "SELECT id FROM items "
        "WHERE deleted_at IS NOT NULL AND deleted_at <= "
        "to_char((now() AT TIME ZONE 'UTC') - interval '7 days', 'YYYY-MM-DD HH24:MI:SS')"
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
    db = create_client(DATABASE_URL)
    app.bot_data["db"] = db
    log.info("PostgreSQL connection ready")

    # Auto-migration: ensure parts table has file_id column
    try:
        await db.execute("ALTER TABLE parts ADD COLUMN IF NOT EXISTS file_id TEXT")
        log.info("Migration: ensured file_id column on parts table")
    except Exception as e:
        pass

    # Auto-migration: realtime change-notification triggers for the web SSE endpoint
    # (/api/events). Statement-level NOTIFY on the tables the drive view enumerates so any
    # write — by the bot, watcher, or web — pushes a live update to open browsers. Idempotent
    # (CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER), so it self-applies to an existing DB
    # on the next deploy/restart even though schema.sql's initdb only runs on a fresh volume.
    try:
        await db.execute(
            "CREATE OR REPLACE FUNCTION notify_drive_change() RETURNS trigger "
            "LANGUAGE plpgsql AS $func$ BEGIN "
            "PERFORM pg_notify('drive_changed', TG_TABLE_NAME); RETURN NULL; END $func$"
        )
        for tbl in ("items", "folders", "item_tags", "tags"):
            await db.execute(f"DROP TRIGGER IF EXISTS trg_notify_{tbl} ON {tbl}")
            await db.execute(
                f"CREATE TRIGGER trg_notify_{tbl} AFTER INSERT OR UPDATE OR DELETE ON {tbl} "
                "FOR EACH STATEMENT EXECUTE FUNCTION notify_drive_change()"
            )
        log.info("Migration: ensured drive_changed NOTIFY triggers")
    except Exception as e:
        log.warning("Migration failed for notify triggers: %s", e)

    # Auto-migration: upload-queue progress NOTIFY on a separate 'upload_changed' channel so the
    # web /upload page refreshes live (SSE) instead of polling. Idempotent; self-applies on restart.
    try:
        await db.execute(
            "CREATE OR REPLACE FUNCTION notify_upload_change() RETURNS trigger "
            "LANGUAGE plpgsql AS $func$ BEGIN "
            "PERFORM pg_notify('upload_changed', TG_TABLE_NAME); RETURN NULL; END $func$"
        )
        await db.execute("DROP TRIGGER IF EXISTS trg_notify_upload_jobs ON upload_jobs")
        await db.execute(
            "CREATE TRIGGER trg_notify_upload_jobs AFTER INSERT OR UPDATE OR DELETE ON upload_jobs "
            "FOR EACH STATEMENT EXECUTE FUNCTION notify_upload_change()"
        )
        log.info("Migration: ensured upload_changed NOTIFY trigger")
    except Exception as e:
        log.warning("Migration failed for upload notify trigger: %s", e)

    # Auto-migration (one-shot, marker-guarded): split existing multi-part MEDIA albums into
    # individual single-part items so the web UI lists each photo/video on its own (tags are
    # shared across the split). Archives are untouched. Runs once; the marker stops re-runs.
    try:
        await db.execute("CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)")
        marker = await db.execute("SELECT 1 FROM bot_settings WHERE key = 'media_albums_split_v1'")
        if not marker.rows:
            n = await split_media_albums(db)
            await db.execute(
                "INSERT INTO bot_settings (key, value) VALUES ('media_albums_split_v1', ?) "
                "ON CONFLICT (key) DO NOTHING",
                [str(n)],
            )
            log.info("Migration: split %s existing media album(s) into individual items", n)
    except Exception as e:
        log.warning("Migration failed for media album split: %s", e)

    # Auto-migration: create authorized_users table
    try:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS authorized_users (
                user_id BIGINT PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                added_at TEXT NOT NULL DEFAULT now_text()
            )
        """)
        log.info("Migration: ensured authorized_users table")
    except Exception as e:
        log.warning("Migration failed for authorized_users: %s", e)

    # Auto-migration: PikPak remote-download queue (download_jobs table + NOTIFY trigger) and
    # requeue of any job stranded mid-download by a previous crash. Idempotent; self-applies.
    try:
        await ensure_pikpak_schema(db)
        log.info("Migration: ensured download_jobs table + pikpak worker schema")
    except Exception as e:
        log.warning("Migration failed for download_jobs: %s", e)

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
            await db.execute("INSERT INTO bot_settings (key, value) VALUES ('web_url', ?) ON CONFLICT (key) DO NOTHING", [default_url])
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
            BotCommand("pikpak", "Download a PikPak file: /pikpak <path>"),
            BotCommand("pikpak_ls", "Browse PikPak: /pikpak_ls [folder]"),
            BotCommand("pikpak_jobs", "Recent download jobs"),
            BotCommand("baidu", "Download a Baidu file: /baidu <path>"),
            BotCommand("baidu_ls", "Browse Baidu: /baidu_ls [folder]"),
            BotCommand("cancel", "Cancel current file upload flow"),
        ]
        await app.bot.set_my_commands(default_commands, scope=BotCommandScopeDefault())
        
        # Admin/Owner commands (only visible in chat with OWNER_USER_ID)
        owner_commands = [
            BotCommand("menu", "Show bot main menu & commands"),
            BotCommand("start", "Trigger file download / Greet"),
            BotCommand("pikpak", "Download a PikPak file: /pikpak <path>"),
            BotCommand("pikpak_ls", "Browse PikPak: /pikpak_ls [folder]"),
            BotCommand("pikpak_jobs", "Recent download jobs"),
            BotCommand("baidu", "Download a Baidu file: /baidu <path>"),
            BotCommand("baidu_ls", "Browse Baidu: /baidu_ls [folder]"),
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

    # Start the PikPak download worker(s) — polls download_jobs, rclone-copies into staging,
    # then hands off to upload_jobs → watcher. Runs as in-process asyncio task(s).
    try:
        start_pikpak_workers(app)
    except Exception as e:
        log.warning("Failed to start PikPak workers: %s", e)



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
                "INSERT INTO authorized_users (user_id, username, first_name) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING",
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
            "INSERT INTO authorized_users (user_id, username, first_name) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING",
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
            "INSERT INTO bot_settings (key, value) VALUES ('web_url', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
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
        [InlineKeyboardButton("☁️ PikPak", callback_data="menu:pikpak_menu")],
    ]

    # Telegram API rejects 'localhost' or '127.0.0.1' in inline keyboard URLs, which causes a BadRequest crash.
    if "localhost" not in web_url and "127.0.0.1" not in web_url:
        keyboard.append([InlineKeyboardButton("🌐 Open Web Dashboard", url=web_url)])

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

    if context.user_data.get("pikpak_await"):
        prompt_id = context.user_data.pop("pikpak_prompt_id", None)
        context.user_data.pop("pikpak_await", None)
        if prompt_id:
            await _delete_messages(context, message.chat_id, [prompt_id])
        await message.reply_text("❌ PikPak prompt cancelled.")
        return

    if "upload_file" in context.user_data or "upload_state" in context.user_data or "upload_queue" in context.user_data:
        # Clean up the questionnaire messages of the active flow + every queued item.
        flow_ids = list((context.user_data.get("upload_file") or {}).get("flow_msg_ids", []))
        for it in context.user_data.get("upload_queue", []):
            flow_ids += it.get("flow_msg_ids", [])
        context.user_data.pop("upload_file", None)
        context.user_data.pop("upload_state", None)
        context.user_data.pop("upload_queue", None)
        await _delete_messages(context, message.chat_id, flow_ids)
        await message.reply_text("❌ Upload flow and queue cancelled.")
    else:
        await message.reply_text("There is no active upload flow to cancel.")


# ---------------------------------------------------------------------------
# Helper to keep the private chat tidy: delete the questionnaire's back-and-forth
# (the bot's Title/Tags prompts + the user's typed Title/Tags replies + queue notices)
# once the user has supplied the metadata, leaving only the final "Success!" summary.
# Best-effort: a message that's already gone / too old to delete is silently skipped.
# ---------------------------------------------------------------------------
async def _delete_messages(context: ContextTypes.DEFAULT_TYPE, chat_id: int, msg_ids, keep_id=None):
    for mid in msg_ids or []:
        if keep_id is not None and mid == keep_id:
            continue
        try:
            await context.bot.delete_message(chat_id=chat_id, message_id=mid)
        except Exception:  # noqa: BLE001 — chat cleanup must never break the flow
            pass


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
        prompt = await context.bot.send_message(
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
        next_file.setdefault("flow_msg_ids", []).append(prompt.message_id)
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
            # The bot's own channel post is NOT echoed back as a channel_post update,
            # so index it inline here instead of relying on on_channel_post.
            try:
                cid = copied_msg.message_id
                if kind == "media":
                    slug = f"{slugify(title)}-{cid}"
                else:
                    slug = slugify(title)
                await index_bot_copy(
                    context, db, cid,
                    title=title, tags=caption_meta["tags"],
                    part_number=part, total=total, kind=kind,
                    slug=slug, set_title=True, source_message=message,
                )
            except Exception:  # noqa: BLE001 — indexing failure shouldn't hide upload success
                log.exception("Inline index failed for direct-caption copy msg %s", copied_msg.message_id)
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
            active_upload.setdefault("messages", []).append(message)
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
                    item.setdefault("messages", []).append(message)
                    if file_size:
                        item["file_size"] += file_size
                    return

        # Otherwise, add it as a new item in the queue
        queue_item = {
            "message_ids": [message.message_id],
            "messages": [message],
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

        qreply = await message.reply_text(
            f"📥 <b>Added to Queue (Position #{pos})</b>\n"
            f"• File Name: <code>{html.escape(file_name or 'Photo/Media')}</code>\n"
            f"• File Size: <code>{file_size / 1024 / 1024:.2f} MB</code>\n\n"
            f"This file will be processed once the active upload flow completes.",
            parse_mode="HTML"
        )
        queue_item.setdefault("flow_msg_ids", []).append(qreply.message_id)
        return

    msg_id = message.message_id
    chat_id = message.chat_id
    web_url = context.bot_data.get("web_url", "http://localhost:3000")
    auto_title = auto_meta["title"]
    auto_tags = auto_meta["tags"]

    context.user_data["upload_file"] = {
        "message_ids": [msg_id],
        "messages": [message],
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

        prompt = await message.reply_text(
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
        context.user_data["upload_file"].setdefault("flow_msg_ids", []).append(prompt.message_id)
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
        prompt = await context.bot.send_message(
            chat_id=message.chat_id,
            text="🏷️ <b>Title set!</b>\n\nWhat are the <b>Tags</b> for this file? (Separate with commas, e.g. <code>holiday, video</code>)\n"
                 "Or click the button below to use the Auto Tags.",
            reply_markup=reply_markup,
            parse_mode="HTML"
        )
        uf = context.user_data.get("upload_file")
        if uf is not None:
            uf.setdefault("flow_msg_ids", []).append(prompt.message_id)
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
    src_messages = upload_file.get("messages") or []
    kind = upload_file.get("kind", "media")
    db = context.bot_data["db"]
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
            # Index inline: the bot's own channel post yields no channel_post update.
            try:
                cid = copied_msg.message_id
                slug = f"{slugify(title)}-{cid}" if kind == "media" else slugify(title)
                await index_bot_copy(
                    context, db, cid, title=title, tags=tags,
                    part_number=1, total=1, kind=kind, slug=slug,
                    set_title=True, source_message=(src_messages[0] if src_messages else None),
                )
            except Exception:  # noqa: BLE001
                log.exception("Inline index failed for single bot upload")
        else:
            # Albums are NOT grouped into one item anymore — copy & index each file as its OWN
            # single-part (1/1) media item, all sharing the one Title/Tags the user supplied for
            # the batch. Each is copied individually (with its own contract caption) so it stays
            # ungrouped in the channel too, exactly matching how it's indexed.
            for idx, mid in enumerate(message_ids):
                src = src_messages[idx] if idx < len(src_messages) else None
                per_caption = f"{title} | 1/1 | {tags_str}"
                try:
                    copied_msg = await context.bot.copy_message(
                        chat_id=STORAGE_CHANNEL_ID,
                        from_chat_id=chat_id,
                        message_id=mid,
                        caption=per_caption,
                    )
                except Exception:  # noqa: BLE001 — one bad member shouldn't sink the rest
                    log.exception("Failed to copy album member msg %s to channel", mid)
                    continue
                try:
                    cid = copied_msg.message_id
                    slug = f"{slugify(title)}-{cid}"
                    await index_bot_copy(
                        context, db, cid, title=title, tags=tags,
                        part_number=1, total=1, kind="media", slug=slug,
                        set_title=True, source_message=src,
                    )
                except Exception:  # noqa: BLE001
                    log.exception("Inline index failed for album member msg %s", copied_msg.message_id)

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
        # Tidy the chat: drop the Title/Tags questionnaire messages (prompts + the user's typed
        # replies), keeping the original file(s) and the final status summary above.
        await _delete_messages(context, chat_id, upload_file.get("flow_msg_ids"))
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

    # PikPak guided input (from the ☁️ PikPak menu buttons) takes priority over the upload flow.
    pikpak_mode = context.user_data.get("pikpak_await")
    if pikpak_mode:
        ptext = (message.text or "").strip()
        prompt_id = context.user_data.pop("pikpak_prompt_id", None)
        context.user_data.pop("pikpak_await", None)  # consumed (a command also cancels the prompt)
        if ptext.startswith("/"):
            return  # let CommandHandlers run
        if pikpak_mode == "path":
            await pikpak_start_download(message, db, ptext)
        elif pikpak_mode == "ls":
            await pikpak_do_ls(message, ptext)
        # Tidy the noise: delete the bot's prompt + the user's typed reply, keep the result.
        cleanup = [message.message_id] + ([prompt_id] if prompt_id else [])
        await _delete_messages(context, message.chat_id, cleanup)
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
        # The user's typed Title reply is questionnaire noise — clean it up on finish.
        context.user_data["upload_file"].setdefault("flow_msg_ids", []).append(message.message_id)
        await prompt_for_tags(update, context)

    elif state == "WAITING_TAGS":
        tags = [t.strip() for t in text.split(",") if t.strip()]
        context.user_data["upload_file"]["tags"] = tags
        context.user_data["upload_file"].setdefault("flow_msg_ids", []).append(message.message_id)
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

    # PikPak interactive browser navigation (pk:up / pk:cd:N / pk:dl:N).
    if data.startswith("pk:"):
        await pikpak_browse_navigate(query, context, data, db)
        return

    if data == "upload:cancel":
        # Clean the questionnaire trail; keep THIS message (we edit it into the cancelled notice).
        flow_ids = list((context.user_data.get("upload_file") or {}).get("flow_msg_ids", []))
        for it in context.user_data.get("upload_queue", []):
            flow_ids += it.get("flow_msg_ids", [])
        context.user_data.pop("upload_file", None)
        context.user_data.pop("upload_state", None)
        context.user_data.pop("upload_queue", None)
        await _delete_messages(context, query.message.chat_id, flow_ids, keep_id=query.message.message_id)
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

    elif data == "menu:pikpak_menu":
        text = (
            "☁️ <b>PikPak Remote-Download</b>\n\n"
            "Pull a file from your PikPak into the cloud drive — all by tapping, "
            "no need to type a command or path:"
        )
        keyboard = [
            [InlineKeyboardButton("📂 Browse & download", callback_data="pikpak:browse")],
            [InlineKeyboardButton("📥 Download by path", callback_data="pikpak:download")],
            [InlineKeyboardButton("📋 Recent jobs", callback_data="pikpak:jobs")],
            [InlineKeyboardButton("⬅️ Back to Menu", callback_data="menu:main")],
        ]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="HTML")

    elif data == "pikpak:browse":
        # Interactive browser: navigate folders + tap a file to download — no typing.
        await pikpak_render_browser(query, context, "")

    elif data == "pikpak:download":
        # Fallback for when you already know/paste an exact path.
        context.user_data["pikpak_await"] = "path"
        prompt = await query.message.reply_text(
            "📥 Send the PikPak <b>file path</b> to download.\n"
            "Example: <code>My Pack/delyn.jpg</code>\n\n"
            "Send /cancel to abort.",
            parse_mode="HTML",
            reply_markup=ForceReply(input_field_placeholder="My Pack/delyn.jpg"),
        )
        context.user_data["pikpak_prompt_id"] = prompt.message_id

    elif data == "pikpak:jobs":
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data="menu:pikpak_menu")]]
        await query.edit_message_text(
            await pikpak_jobs_text(db),
            reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="HTML",
        )

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
    app.add_handler(CommandHandler("pikpak", on_pikpak))
    app.add_handler(CommandHandler("pikpak_ls", on_ls))
    app.add_handler(CommandHandler("pikpak_jobs", on_jobs))
    app.add_handler(CommandHandler("baidu", on_baidu))
    app.add_handler(CommandHandler("baidu_ls", on_baidu_ls))

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



    # Daily purge of trashed items older than 7 days (03:00 UTC).
    app.job_queue.run_daily(purge_job, time=dtime(hour=3, minute=0))

    # Daily PostgreSQL backup → Telegram, indexed under Backup / CDT DB (04:00 UTC).
    app.job_queue.run_daily(run_backup, time=dtime(hour=4, minute=0))

    log.info("Bot starting polling…")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
