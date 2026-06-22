"""Channel indexing: index new channel posts (Flow C), harvest thumbnails, and
inline-index posts the bot created itself via copy_message (Bot Drop)."""

import asyncio
import io
import os

from telegram import Update
from telegram.ext import ContextTypes

from bot_config import OWNER_USER_ID, STORAGE_CHANNEL_ID, log
from tg_helpers import (
    detect_kind,
    parse_caption,
    derive_media_meta,
    get_file_meta,
    get_file_id,
    pick_thumb_file_id,
    encode_thumbnail,
    slugify,
)
from db_ops import (
    upsert_item,
    upsert_part,
    recompute_totals,
    sync_tags,
    sync_album_tags,
    upsert_thumbnail,
)


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
        # Album members are NOT grouped anymore — each photo/video is its OWN item. The slug is
        # keyed off the album's media_group_id so siblings stay discoverable (for tag-syncing),
        # but each member is unique via its own msg_id. Each is single-part (1/1).
        slug = f"m{mgid}-{msg_id}"
        part_number = 1
    elif kind == "media":
        # Single media: each post = its own item (titles may repeat).
        slug = f"{slugify(title)}-{msg_id}"
        part_number = parsed["part"]
    else:
        # Archive: slug purely from title so parts 1..N are grouped into one item.
        slug = slugify(title)
        part_number = parsed["part"]

    # Split album members are single-part items; everything else keeps its caption's total.
    total = 1 if (kind == "media" and mgid) else parsed["total"]

    file_name, file_size = get_file_meta(message)
    file_id = get_file_id(message)

    try:
        item_id = await upsert_item(db, slug, title, kind, total, set_title=has_caption)
        part_id = await upsert_part(db, item_id, part_number, msg_id, file_name, file_size, file_id)

        await recompute_totals(db, item_id)
        await sync_tags(db, item_id, parsed["tags"])
        # Keep tags consistent across all individual items split from the same album.
        if kind == "media" and mgid:
            await sync_album_tags(db, mgid, parsed["tags"])

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
            mime, data_b64 = encode_thumbnail(data_bytes)
            await upsert_thumbnail(db, part_id, mime, data_b64)
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


async def harvest_thumbnail(context, db, part_id, message, channel_msg_id=None):
    """Download Telegram's built-in thumbnail for ONE part → WebP base64 → thumbnails.

    `message` supplies the thumbnail file_id; `channel_msg_id` is the message to
    re-fetch on the deferred path (defaults to message.message_id, which is correct
    when `message` is itself the channel post, but must be passed explicitly when the
    thumbnail source is a private-chat message that was copied into the channel).

    If the thumbnail is not yet available (Telegram generates it asynchronously),
    schedules a deferred retry after 60 s.
    """
    if channel_msg_id is None:
        channel_msg_id = message.message_id
    file_id = pick_thumb_file_id(message)
    if not file_id:
        log.info("No thumbnail yet for part_id=%s — scheduling deferred harvest in 60 s", part_id)
        asyncio.create_task(
            _deferred_harvest(context.bot, db, part_id, channel_msg_id)
        )
        return
    tg_file = await context.bot.get_file(file_id)
    data_bytes = await download_file_content(tg_file)
    mime, data_b64 = encode_thumbnail(data_bytes)
    await upsert_thumbnail(db, part_id, mime, data_b64)


async def index_bot_copy(
    context, db, channel_msg_id, *, title, tags, part_number, total,
    kind, slug, set_title=True, source_message=None,
):
    """Index a channel post the bot created itself via copy_message / copy_messages.

    Telegram does NOT deliver a channel_post update for the bot's OWN messages, so
    `on_channel_post` never fires for Bot-Drop uploads → they would never be indexed.
    We index them inline here using the original private-chat message for metadata.

    Idempotent (keyed on `channel_msg_id`), so if a real update ever did arrive it
    would be a harmless no-op. `file_id` is stored NULL — the streamer resolves a
    fresh, channel-scoped file_id on demand via forwarding (see streamer.py).
    """
    file_name, file_size = (None, 0)
    if source_message is not None:
        file_name, file_size = get_file_meta(source_message)

    item_id = await upsert_item(db, slug, title, kind, total, set_title=set_title)
    part_id = await upsert_part(
        db, item_id, part_number, channel_msg_id, file_name, file_size or 0, file_id=None
    )
    await recompute_totals(db, item_id)
    await sync_tags(db, item_id, tags)

    if kind == "media":
        if source_message is not None:
            await harvest_thumbnail(context, db, part_id, source_message, channel_msg_id=channel_msg_id)
        else:
            asyncio.create_task(_deferred_harvest(context.bot, db, part_id, channel_msg_id))

    log.info("Indexed (bot copy): %s [%s] part %s (msg=%s)", slug, kind, part_number, channel_msg_id)
    return item_id
