"""
Lihat isi katalog Turso (monitoring manual).
Pakai:  python status.py
"""

import asyncio
import os

from dotenv import load_dotenv
import libsql_client

load_dotenv()
url = os.environ["TURSO_DATABASE_URL"]
if url.startswith("libsql://"):
    url = "https://" + url[len("libsql://"):]


async def main():
    db = libsql_client.create_client(url=url, auth_token=os.environ.get("TURSO_AUTH_TOKEN"))
    items = await db.execute(
        "SELECT id, slug, title, kind, total_parts, total_size, is_favorite, deleted_at "
        "FROM items ORDER BY id"
    )
    print(f"=== {len(items.rows)} item ===")
    for r in items.rows:
        fav = "★" if r[6] else " "
        trash = "  [SAMPAH]" if r[7] else ""
        gb = (r[5] or 0) / 1024 / 1024 / 1024
        print(f"  {fav} #{r[0]} [{r[3]:5}] {r[2]}  — {r[4]} part, {gb:.2f} GB — slug={r[1]}{trash}")
    th = await db.execute(
        "SELECT p.item_id, COUNT(*) FROM thumbnails t "
        "JOIN parts p ON p.id = t.part_id GROUP BY p.item_id ORDER BY p.item_id"
    )
    print("Thumbnail per item (item_id: jumlah):", {r[0]: r[1] for r in th.rows})
    await db.close()


asyncio.run(main())
