"""Jalankan file migration SQL terhadap Turso (HTTPS), memakai kredensial bot/.env.

Dipakai SEKALI (Turso CLI tidak terpasang di mesin ini):
    python run-migration.py migration-thumbnails-per-part.sql

Catatan: hentikan dulu bot.py & watcher sebelum migrasi yang mengubah skema,
supaya tidak ada penulisan ke tabel yang sedang dipindah. Lihat header file .sql.
"""

import asyncio
import os
import sys

from dotenv import load_dotenv
import libsql_client

load_dotenv()
url = os.environ["TURSO_DATABASE_URL"]
if url.startswith("libsql://"):  # ws transport ditolak Turso → HTTPS (lihat bot.py)
    url = "https://" + url[len("libsql://"):]


def split_statements(sql: str):
    """Buang komentar baris (-- ...), lalu pisah per ';' (tak ada ';' di dalam string)."""
    body = "\n".join(
        line for line in sql.splitlines() if not line.strip().startswith("--")
    )
    return [s.strip() for s in body.split(";") if s.strip()]


async def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "migration-thumbnails-per-part.sql"
    with open(path, "r", encoding="utf-8") as f:
        statements = split_statements(f.read())

    db = libsql_client.create_client(url=url, auth_token=os.environ.get("TURSO_AUTH_TOKEN"))
    print(f"Menjalankan {len(statements)} statement dari {path} …")
    try:
        for i, stmt in enumerate(statements, 1):
            head = " ".join(stmt.split())[:70]
            print(f"  [{i}/{len(statements)}] {head}…")
            await db.execute(stmt)
    finally:
        await db.close()
    print("Migration selesai.")


asyncio.run(main())
