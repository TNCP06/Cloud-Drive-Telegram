"""Idempotent Turso operations. Each takes a libsql `db` client as its first arg."""

import os
import re

from bot_config import OWNER_USER_ID


async def is_user_authorized(db, user_id: int) -> bool:
    if user_id == OWNER_USER_ID:
        return True
    try:
        rs = await db.execute("SELECT 1 FROM authorized_users WHERE user_id = ?", [user_id])
        return len(rs.rows) > 0
    except Exception:
        # If the table doesn't exist yet, fallback to owner-only
        return False


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
    """Ensure tags exist and are linked to the item (many-to-many).

    Case-insensitive: a tag that differs from an existing one only in capitalization
    reuses that tag instead of creating a duplicate (e.g. "game" → existing "Game").
    """
    for name in tags:
        name = (name or "").strip()
        if not name:
            continue
        rs = await db.execute("SELECT id FROM tags WHERE name = ? COLLATE NOCASE", [name])
        if rs.rows:
            tag_id = rs.rows[0][0]
        else:
            await db.execute("INSERT INTO tags (name) VALUES (?)", [name])
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
