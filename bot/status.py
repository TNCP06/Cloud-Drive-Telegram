"""
View the PostgreSQL catalog contents (manual monitoring).
Usage:  python status.py
"""

import asyncio

from dotenv import load_dotenv
from pg_db import create_client

load_dotenv()


async def main():
    db = create_client()
    items = await db.execute(
        "SELECT id, slug, title, kind, total_parts, total_size, is_favorite, deleted_at "
        "FROM items ORDER BY id"
    )
    print(f"=== {len(items.rows)} item(s) ===")
    for r in items.rows:
        fav = "★" if r[6] else " "
        trash = "  [TRASH]" if r[7] else ""
        gb = (r[5] or 0) / 1024 / 1024 / 1024
        print(f"  {fav} #{r[0]} [{r[3]:5}] {r[2]}  — {r[4]} part(s), {gb:.2f} GB — slug={r[1]}{trash}")
    th = await db.execute(
        "SELECT p.item_id, COUNT(*) FROM thumbnails t "
        "JOIN parts p ON p.id = t.part_id GROUP BY p.item_id ORDER BY p.item_id"
    )
    print("Thumbnails per item (item_id: count):", {r[0]: r[1] for r in th.rows})
    await db.close()


asyncio.run(main())
