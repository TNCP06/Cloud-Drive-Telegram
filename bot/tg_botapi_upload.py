"""Fast upload path: send a part through the LOCAL telegram-bot-api server (bot account)
instead of Telethon (user account).

Why: Telethon uploads run as the non-premium USER account, which Telegram throttles with
FLOOD_PREMIUM_WAIT on SaveBigFilePartRequest (~4 s pauses, effective ~5 MB/s). Bot accounts
are not subject to that premium upsell throttle, and the local Bot API server (TELEGRAM_LOCAL)
accepts a `file://` path directly — the file never travels over HTTP, the server reads it off
the shared staging volume and does the MTProto upload itself at full VPS speed.

Requirements (all on the VPS compose stack):
  - TELEGRAM_API_URL + BOT_TOKEN in the watcher env,
  - the telegram-bot-api container mounts the staging volume at the same path (/staging),
    so `file:///staging/...` resolves inside it — available() checks the path prefix.

Because the channel post is made by the bot's own token, the bot process never receives a
channel_post update for it (Telegram doesn't echo a bot its own posts) — so the caller MUST
index the part inline (index_uploaded below, same db_ops the bot uses). Telethon remains the
fallback: laptop runs (no local server), files outside staging, or any API error.

Known degradation vs the Telethon path: no per-byte progress callback (progress advances per
part) and no Telegram-side thumbnail harvest for photos (the watcher's ffmpeg thumbnail
fallback still covers videos; the web's reharvest action repairs stragglers).
"""

import os

import httpx

TELEGRAM_API_URL = os.environ.get("TELEGRAM_API_URL")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
UPLOAD_VIA_BOT_API = os.environ.get("UPLOAD_VIA_BOT_API", "1") not in ("0", "false", "False", "")
# Paths that the telegram-bot-api container can also see (colon-separated prefixes).
BOT_API_VISIBLE_PREFIXES = tuple(
    p for p in os.environ.get("BOT_API_VISIBLE_PREFIXES", "/staging").split(":") if p
)

_PHOTO_EXTS = {".jpg", ".jpeg", ".png"}
_VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".3gp"}


def available(path: str) -> bool:
    """True when this part can take the fast path (config present + file visible to the server)."""
    return bool(
        UPLOAD_VIA_BOT_API and TELEGRAM_API_URL and BOT_TOKEN
        and os.path.abspath(path).startswith(BOT_API_VISIBLE_PREFIXES)
    )


async def send_part(path: str, caption: str, as_document: bool, chat_id: int):
    """Send one part via the local Bot API → (message_id, file_id, sent_as_document).
    Raises RuntimeError on an API refusal (caller falls back to Telethon)."""
    ext = os.path.splitext(path)[1].lower()
    if not as_document and ext in _VIDEO_EXTS:
        method, field, extra = "sendVideo", "video", {"supports_streaming": True}
    elif not as_document and ext in _PHOTO_EXTS:
        method, field, extra = "sendPhoto", "photo", {}
    else:
        method, field, extra = "sendDocument", "document", {}
        as_document = True
    payload = {
        "chat_id": chat_id,
        "caption": caption,
        field: f"file://{os.path.abspath(path)}",
        **extra,
    }
    # Generous timeout: the server-side MTProto upload of a ~1.9 GB part can take minutes.
    async with httpx.AsyncClient(timeout=httpx.Timeout(1800.0, connect=30.0)) as cli:
        r = await cli.post(f"{TELEGRAM_API_URL}/bot{BOT_TOKEN}/{method}", json=payload)
    try:
        data = r.json()
    except ValueError:
        raise RuntimeError(f"bot-api {method}: non-JSON response ({r.status_code})")
    if not data.get("ok"):
        raise RuntimeError(f"bot-api {method} failed: {data.get('description', str(data)[:200])}")
    msg = data["result"]
    media = msg.get("video") or msg.get("document") or (msg.get("photo") or [{}])[-1] or {}
    return msg["message_id"], media.get("file_id"), as_document


async def index_uploaded(db, title, tags, part_no, total, kind, msg_id, file_name, file_size, file_id):
    """Inline index of a bot-api-uploaded part — the bot gets no channel_post update for its own
    token's posts, so the watcher does exactly what the bot's indexer would have done. Slug rules
    mirror bot.py: media → slugify(title)-<msg_id> (titles may repeat), archive → slugify(title)
    (grouping key for the split parts)."""
    # Deferred imports: db_ops pulls in bot_config (BOT_TOKEN required at import), which only
    # exists on the VPS stack — a laptop watcher run never reaches this function.
    from db_ops import recompute_totals, sync_tags, upsert_item, upsert_part
    from tg_helpers import slugify

    slug = f"{slugify(title)}-{msg_id}" if kind == "media" else slugify(title)
    item_id = await upsert_item(db, slug, title, kind, total, set_title=True)
    await upsert_part(db, item_id, part_no, msg_id, file_name, file_size, file_id)
    await recompute_totals(db, item_id)
    if tags:
        await sync_tags(db, item_id, tags)
    return item_id
