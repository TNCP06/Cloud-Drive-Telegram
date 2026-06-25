"""Pure helpers (no I/O): caption parsing, message inspection, thumbnail encoding."""

import base64
import io
import os
import re
import unicodedata

# Caption contract: "Title | part/total | tag1, tag2"
CAPTION_RE = re.compile(
    r"^(?P<title>.+?)\s*\|\s*(?P<part>\d+)\s*/\s*(?P<total>\d+)\s*\|\s*(?P<tags>.*)$"
)


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
    """Return (file_name, file_size) for this part.

    Videos and animations that lack a file_name get a synthetic name so the
    web's extension-based type detection can distinguish them from photos
    (which legitimately have no file name).
    """
    if message.document:
        return message.document.file_name, message.document.file_size or 0
    if message.video:
        name = message.video.file_name or "video.mp4"
        return name, message.video.file_size or 0
    if message.animation:
        name = message.animation.file_name or "animation.mp4"
        return name, message.animation.file_size or 0
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


def encode_thumbnail(data_bytes: bytes) -> tuple[str, str]:
    """Convert raw image bytes to a compact WebP base64 string → (mime, base64).

    Telegram's built-in thumbnails are JPEG; re-encoding to WebP is ~25-35% smaller
    at the same visual quality, shrinking the base64 blobs stored in Turso and shipped
    to the browser. Falls back to JPEG passthrough if Pillow is unavailable or the
    source can't be decoded — a thumbnail is never lost over an encoding issue.
    """
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data_bytes)) as img:
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            out = io.BytesIO()
            img.save(out, format="WEBP", quality=80, method=6)
            return "image/webp", base64.b64encode(out.getvalue()).decode("ascii")
    except Exception:  # noqa: BLE001
        return "image/jpeg", base64.b64encode(data_bytes).decode("ascii")
