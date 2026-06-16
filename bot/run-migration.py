"""Run a SQL migration file against Turso (HTTPS) using credentials from bot/.env.

Intended for one-off use (when the Turso CLI is not installed on this machine):
    python run-migration.py migration-thumbnails-per-part.sql

Note: stop bot.py and watcher before running schema-changing migrations so no
writes are attempted against tables being altered. See the .sql file header.
"""

import asyncio
import os
import sys

from dotenv import load_dotenv
import libsql_client

load_dotenv()
url = os.environ["TURSO_DATABASE_URL"]
if url.startswith("libsql://"):  # WebSocket transport rejected by Turso → use HTTPS (see bot.py)
    url = "https://" + url[len("libsql://"):]


def split_statements(sql: str):
    """Strip line comments (-- ...) then split on ';' (no ';' inside strings)."""
    body = "\n".join(
        line for line in sql.splitlines() if not line.strip().startswith("--")
    )
    return [s.strip() for s in body.split(";") if s.strip()]


async def main():
    if len(sys.argv) < 2:
        print("Usage: python run-migration.py <migration-file.sql>")
        sys.exit(1)
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as f:
        statements = split_statements(f.read())

    db = libsql_client.create_client(url=url, auth_token=os.environ.get("TURSO_AUTH_TOKEN"))
    print(f"Running {len(statements)} statement(s) from {path} …")
    try:
        for i, stmt in enumerate(statements, 1):
            head = " ".join(stmt.split())[:70]
            print(f"  [{i}/{len(statements)}] {head}…")
            await db.execute(stmt)
    finally:
        await db.close()
    print("Migration complete.")


asyncio.run(main())
