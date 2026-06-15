"""
Telegram Cloud Drive — bot indexer.

Milestone 2 (+ album & media-fallback): handler channel_post.
Alur: setiap file baru yang masuk ke STORAGE_CHANNEL_ID -> parse caption
(kontrak: "Judul | part/total | tag1, tag2") -> upsert ke Turso (items + parts + tags).
- GAME : caption WAJIB (judul = kunci grouping, part/total = perakitan). Invalid ->
  warning ke owner supaya tak ada file hilang diam-diam.
- MEDIA: caption OPSIONAL. Tanpa caption valid, metadata diturunkan dari caption
  bebas / nama file / tanggal (lihat derive_media_meta) → media tak pernah hilang.
- ALBUM (media group: beberapa foto/video sekali kirim) -> disatukan jadi SATU item
  multi-part lewat media_group_id; tiap part punya thumbnail sendiri (galeri di web).
Thumbnail bawaan Telegram di-harvest per-part ke tabel `thumbnails`.

Catatan API:
- Bot harus admin di channel agar menerima update channel_post.
- Thumbnail diambil via get_file (kecil, di bawah limit 20 MB) — hanya untuk media.
"""

import asyncio
import base64
import io
import logging
import os
import re
import unicodedata
from datetime import time as dtime

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
# Konfigurasi & environment
# ---------------------------------------------------------------------------
load_dotenv()  # memuat bot/.env saat dijalankan dari folder bot/

BOT_TOKEN = os.environ["BOT_TOKEN"]
STORAGE_CHANNEL_ID = int(os.environ["STORAGE_CHANNEL_ID"])
OWNER_USER_ID = int(os.environ["OWNER_USER_ID"])
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")


def _turso_http_url(url: str) -> str:
    # Transport WebSocket libsql_client ditolak Turso (HTTP 400) → pakai HTTPS (Hrana over HTTP).
    if url.startswith("libsql://"):
        return "https://" + url[len("libsql://") :]
    return url


TURSO_DATABASE_URL = _turso_http_url(os.environ["TURSO_DATABASE_URL"])

logging.basicConfig(
    format="%(asctime)s — %(name)s — %(levelname)s — %(message)s",
    level=logging.INFO,
)
# Kurangi noise dari httpx (PTB internal HTTP).
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("cloud-drive-bot")

# Kontrak caption: "Judul | part/total | tag1, tag2"
CAPTION_RE = re.compile(
    r"^(?P<title>.+?)\s*\|\s*(?P<part>\d+)\s*/\s*(?P<total>\d+)\s*\|\s*(?P<tags>.*)$"
)

# ---------------------------------------------------------------------------
# Helper murni (tanpa I/O)
# ---------------------------------------------------------------------------
def slugify(text: str) -> str:
    """Ubah judul menjadi slug URL-safe & stabil (kunci unik item)."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    text = re.sub(r"[-\s]+", "-", text)
    return text or "untitled"


def parse_caption(caption: str | None):
    """Return dict {title, part, total, tags} bila cocok kontrak, else None."""
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
    """Tentukan 'media' (punya thumbnail) atau 'game' (arsip). None bila bukan file."""
    if message.photo or message.video or message.animation:
        return "media"
    doc = message.document
    if doc:
        mime = doc.mime_type or ""
        if mime.startswith("image/") or mime.startswith("video/"):
            return "media"
        return "game"  # arsip .7z / .zip / split parts dll.
    return None


def get_file_meta(message):
    """Return (file_name, file_size) untuk part ini."""
    if message.document:
        return message.document.file_name, message.document.file_size or 0
    if message.video:
        return message.video.file_name, message.video.file_size or 0
    if message.animation:
        return message.animation.file_name, message.animation.file_size or 0
    if message.photo:
        return None, message.photo[-1].file_size or 0
    return None, 0


def derive_media_meta(message):
    """Metadata fallback untuk MEDIA yang captionnya tak sesuai kontrak.

    Selalu menghasilkan title (tak pernah None) supaya media tak pernah hilang.
    Return (parsed_dict, has_caption); has_caption=True bila judul berasal dari
    caption asli — dipakai agar anggota album TANPA caption tak menimpa judul
    yang sudah diisi anggota album yang BER-caption.
    """
    caption = message.caption
    tags: list[str] = []
    title = None
    if caption and caption.strip():
        text = caption.strip()
        # Hashtag sering menempel pada konten yang di-forward → jadikan tag.
        tags = [t.lstrip("#") for t in re.findall(r"#\w+", text)]
        # Judul = baris pertama tanpa hashtag, dipangkas.
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
    """Ambil file_id thumbnail bawaan Telegram untuk item media."""
    if message.photo:
        # message.photo = list PhotoSize (kecil -> besar). Ambil terbesar (di bawah
        # limit get_file 20 MB) supaya preview di web tajam.
        return message.photo[-1].file_id
    if message.video and message.video.thumbnail:
        return message.video.thumbnail.file_id
    if message.animation and message.animation.thumbnail:
        return message.animation.thumbnail.file_id
    if message.document and message.document.thumbnail:
        return message.document.thumbnail.file_id
    return None


# ---------------------------------------------------------------------------
# Operasi Turso (idempotent)
# ---------------------------------------------------------------------------
async def upsert_item(db, slug, title, kind, total, set_title=True) -> int:
    """Upsert item by slug, return item_id.

    set_title=False → JANGAN timpa judul yang sudah ada. Dipakai anggota album
    tanpa caption agar tak menimpa judul yang sudah diisi anggota ber-caption
    (urutan kedatangan update album tidak dijamin).
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


async def upsert_part(db, item_id, part_number, channel_msg_id, file_name, file_size) -> int:
    """Upsert part by channel_msg_id (kunci idempotensi & target copy_message). Return part_id."""
    await db.execute(
        """
        INSERT INTO parts (item_id, part_number, channel_msg_id,
                           file_name, file_size, uploaded_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(channel_msg_id) DO UPDATE SET
            item_id     = excluded.item_id,
            part_number = excluded.part_number,
            file_name   = excluded.file_name,
            file_size   = excluded.file_size
        """,
        [item_id, part_number, channel_msg_id, file_name, file_size],
    )
    rs = await db.execute("SELECT id FROM parts WHERE channel_msg_id = ?", [channel_msg_id])
    return rs.rows[0][0]


async def recompute_totals(db, item_id):
    """Sinkronkan total_size & total_parts dari baris parts yang ada."""
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
    """Pastikan tags ada dan terhubung ke item (many-to-many)."""
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
# Handler channel_post
# ---------------------------------------------------------------------------
async def warn_owner(context, text):
    try:
        await context.bot.send_message(chat_id=OWNER_USER_ID, text=text)
    except Exception:  # noqa: BLE001 — jangan biarkan gagal-kirim merusak handler
        log.exception("Gagal mengirim warning ke owner")


async def on_channel_post(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.channel_post
    if message is None:
        return

    db = context.bot_data["db"]
    msg_id = message.message_id

    kind = detect_kind(message)
    if kind is None:
        # Post teks biasa (pengumuman, dll.) — bukan file, abaikan.
        return

    parsed = parse_caption(message.caption)
    if parsed is not None:
        has_caption = True
    elif kind == "media":
        # Media tak butuh caption terstruktur — turunkan metadata & tetap index.
        parsed, has_caption = derive_media_meta(message)
    else:
        # Game multi-part WAJIB caption (judul = kunci grouping, part/total = perakitan).
        log.warning("Caption invalid pada msg %s (game)", msg_id)
        await warn_owner(
            context,
            "⚠️ Caption tidak sesuai format, file BELUM terindeks.\n"
            f"Pesan: https://t.me/c/{str(STORAGE_CHANNEL_ID)[4:]}/{msg_id}\n"
            f"Caption: {message.caption or '(kosong)'}\n\n"
            "Format wajib: Judul | part/total | tag1, tag2",
        )
        return

    title = parsed["title"]
    mgid = message.media_group_id

    if kind == "media" and mgid:
        # ALBUM (media group): semua foto/video se-grup → SATU item multi-part.
        # slug dari media_group_id agar stabil walau pesan ber-caption tiba belakangan.
        # part_number = msg_id → unik per item, urut sesuai album, anti-race antar update.
        slug = f"album-{mgid}"
        part_number = msg_id
    elif kind == "media":
        # Media tunggal: tiap post = item tersendiri (judul boleh berulang).
        slug = f"{slugify(title)}-{msg_id}"
        part_number = parsed["part"]
    else:
        # Game: slug murni dari judul agar part 1..N ter-group jadi satu item.
        slug = slugify(title)
        part_number = parsed["part"]

    file_name, file_size = get_file_meta(message)

    try:
        item_id = await upsert_item(db, slug, title, kind, parsed["total"], set_title=has_caption)
        part_id = await upsert_part(db, item_id, part_number, msg_id, file_name, file_size)
        await recompute_totals(db, item_id)
        await sync_tags(db, item_id, parsed["tags"])

        # Harvest thumbnail per-part (hanya media; tiap foto/video punya thumbnail sendiri).
        if kind == "media":
            await harvest_thumbnail(context, db, part_id, message)

        log.info(
            "Terindeks: %s [%s] part %s (item_id=%s, msg=%s)",
            slug, kind, part_number, item_id, msg_id,
        )
    except Exception:  # noqa: BLE001
        log.exception("Gagal indexing msg %s", msg_id)
        await warn_owner(
            context,
            f"⚠️ Error saat indexing '{title}' (msg {msg_id}). Cek log bot.",
        )


async def harvest_thumbnail(context, db, part_id, message):
    """Download thumbnail bawaan Telegram untuk SATU part -> base64 -> tabel thumbnails."""
    file_id = pick_thumb_file_id(message)
    if not file_id:
        log.info("Media tanpa thumbnail (part_id=%s), dilewati", part_id)
        return
    tg_file = await context.bot.get_file(file_id)
    buf = io.BytesIO()
    await tg_file.download_to_memory(out=buf)
    data_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    # Thumbnail bawaan Telegram berformat JPEG.
    await upsert_thumbnail(db, part_id, "image/jpeg", data_b64)


# ---------------------------------------------------------------------------
# Handler /start — download via copy_message (owner-only)
# ---------------------------------------------------------------------------
async def on_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if message is None:
        return

    # Keamanan: hanya owner yang boleh memicu download.
    if user is None or user.id != OWNER_USER_ID:
        await message.reply_text("⛔ Akses ditolak. Bot ini privat.")
        return

    # Deep link "?start=<slug>" → PTB mengisi context.args.
    if not context.args:
        await message.reply_text(
            "Halo! Buka dashboard, klik menu ⋮ pada sebuah item lalu pilih Unduh — "
            "filenya akan dikirim ke sini."
        )
        return

    db = context.bot_data["db"]
    slug = context.args[0]

    rs = await db.execute(
        "SELECT id, title FROM items WHERE slug = ? AND deleted_at IS NULL", [slug]
    )
    if not rs.rows:
        await message.reply_text("Item tidak ditemukan atau sudah dihapus.")
        return
    item_id, title = rs.rows[0][0], rs.rows[0][1]

    parts = await db.execute(
        "SELECT channel_msg_id FROM parts WHERE item_id = ? ORDER BY part_number", [item_id]
    )
    if not parts.rows:
        await message.reply_text("Item ini belum memiliki file.")
        return

    total = len(parts.rows)
    await message.reply_text(f'Mengirim "{title}" ({total} part)…')
    for row in parts.rows:
        msg_id = row[0]
        try:
            # copy_message = operasi referensi (lewat limit ukuran) & menyembunyikan channel.
            await context.bot.copy_message(
                chat_id=user.id, from_chat_id=STORAGE_CHANNEL_ID, message_id=msg_id
            )
        except Exception:  # noqa: BLE001
            log.exception("Gagal copy_message msg %s", msg_id)
        await asyncio.sleep(0.3)  # jaga jarak dari flood limit


# ---------------------------------------------------------------------------
# JobQueue — purge harian item sampah >7 hari
# ---------------------------------------------------------------------------
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
            except Exception:  # noqa: BLE001 — pesan mungkin sudah terhapus
                log.exception("Gagal delete_message msg %s", row[0])
            await asyncio.sleep(0.2)
        # Hard delete eksplisit (tidak bergantung pada PRAGMA foreign_keys).
        # thumbnails kini ber-FK ke parts → hapus duluan sebelum parts.
        await db.execute(
            "DELETE FROM thumbnails WHERE part_id IN (SELECT id FROM parts WHERE item_id = ?)",
            [item_id],
        )
        await db.execute("DELETE FROM parts WHERE item_id = ?", [item_id])
        await db.execute("DELETE FROM item_tags WHERE item_id = ?", [item_id])
        await db.execute("DELETE FROM items WHERE id = ?", [item_id])
        purged += 1

    log.info("Purge selesai: %s item dihapus permanen", purged)
    try:
        await context.bot.send_message(
            chat_id=OWNER_USER_ID,
            text=f"🧹 Purge: {purged} item dihapus permanen dari channel & database.",
        )
    except Exception:  # noqa: BLE001
        log.exception("Gagal kirim ringkasan purge")


# ---------------------------------------------------------------------------
# Lifecycle Turso
# ---------------------------------------------------------------------------
async def post_init(app: Application):
    app.bot_data["db"] = libsql_client.create_client(
        url=TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN
    )
    log.info("Koneksi Turso siap")


async def post_shutdown(app: Application):
    db = app.bot_data.get("db")
    if db is not None:
        await db.close()
        log.info("Koneksi Turso ditutup")


# ---------------------------------------------------------------------------
# Handler Private Chat (Bot Drop)
# ---------------------------------------------------------------------------
async def on_private_file(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    if not message or not user or user.id != OWNER_USER_ID:
        return

    kind = detect_kind(message)
    if not kind:
        # Bukan media/dokumen
        return

    msg_id = message.message_id
    chat_id = message.chat_id
    web_url = os.environ.get("NEXT_PUBLIC_WEB_URL", "http://localhost:3000").rstrip("/")
    
    link = f"{web_url}/upload-bot?msg_id={msg_id}&chat_id={chat_id}"
    
    await message.reply_text(
        f"✅ File diterima di Bot!\n\nSilakan klik tautan di bawah ini untuk melengkapi data file (Judul & Tag) melalui web. Bot akan otomatis meneruskannya ke Channel setelah data disimpan.\n\n👉 {link}",
        disable_web_page_preview=True
    )


def main():
    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .post_shutdown(post_shutdown)
        .build()
    )

    # /start (download, owner-only) — chat privat.
    app.add_handler(CommandHandler("start", on_start))

    # Handler bot drop (menerima file di chat privat bot)
    app.add_handler(
        MessageHandler(
            filters.ChatType.PRIVATE & (filters.Document.ALL | filters.VIDEO | filters.PHOTO | filters.ANIMATION),
            on_private_file,
        )
    )

    # Hanya proses channel_post dari STORAGE_CHANNEL_ID.
    app.add_handler(
        MessageHandler(
            filters.Chat(STORAGE_CHANNEL_ID) & filters.UpdateType.CHANNEL_POST,
            on_channel_post,
        )
    )

    # Purge harian item sampah >7 hari (03:00 UTC).
    app.job_queue.run_daily(purge_job, time=dtime(hour=3, minute=0))

    log.info("Bot mulai polling…")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
