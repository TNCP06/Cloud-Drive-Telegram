"""PostgreSQL client shim mimicking the tiny libsql_client surface the bot uses.

The whole bot (bot.py / watcher.py / streamer.py / index_history.py /
db_ops.py) only ever calls `await db.execute(sql, params)` and reads `result.rows`
(a list of tuples, index-accessed as `row[0]`), plus `await db.close()`. This wraps
a psycopg3 async connection pool to provide exactly that, so the existing call sites —
including their `?` placeholders — stay unchanged. `?` is rewritten to psycopg's `%s`;
the SQL itself uses the Postgres dialect (now_text(), ON CONFLICT, lower(), …).

Connections run in autocommit mode, matching libSQL's statement-at-a-time behavior:
a failed DDL probe (e.g. "ALTER TABLE … ADD COLUMN" when it already exists) does not
poison later statements.
"""

import asyncio
import os
import re

from psycopg_pool import AsyncConnectionPool

_PLACEHOLDER = re.compile(r"\?")


def _to_pg(sql: str) -> str:
    # `?` → `%s`. The bot's SQL contains no literal `%`, so this substitution is safe.
    return _PLACEHOLDER.sub("%s", sql)


class _Result:
    __slots__ = ("rows", "rows_affected")

    def __init__(self, rows, rows_affected=0):
        self.rows = rows
        self.rows_affected = rows_affected


class PgClient:
    """Minimal async wrapper around a psycopg connection pool (autocommit)."""

    def __init__(self, dsn: str):
        self._pool = AsyncConnectionPool(
            dsn, min_size=1, max_size=10, open=False,
            kwargs={"autocommit": True},
        )
        self._opened = False
        self._lock = asyncio.Lock()

    async def _ensure_open(self):
        if self._opened:
            return
        async with self._lock:
            if not self._opened:
                await self._pool.open()
                await self._pool.wait()
                self._opened = True

    async def execute(self, sql, params=None):
        await self._ensure_open()
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(_to_pg(sql), tuple(params) if params else None)
                rows = await cur.fetchall() if cur.description is not None else []
                affected = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0
        return _Result(rows, affected)

    async def close(self):
        if self._opened:
            await self._pool.close()
            self._opened = False


def database_url() -> str:
    """The Postgres DSN. Accepts DATABASE_URL (preferred) or POSTGRES_* parts."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    user = os.environ.get("POSTGRES_USER", "cdt")
    pw = os.environ.get("POSTGRES_PASSWORD", "")
    host = os.environ.get("POSTGRES_HOST", "postgres")
    port = os.environ.get("POSTGRES_PORT", "5432")
    name = os.environ.get("POSTGRES_DB", "cdt")
    return f"postgresql://{user}:{pw}@{host}:{port}/{name}"


def create_client(url=None, auth_token=None, **_):
    """libsql_client.create_client-compatible factory.

    `url`/`auth_token` are accepted for call-site compatibility but ignored unless `url`
    is a real Postgres DSN; otherwise the DSN comes from DATABASE_URL / POSTGRES_*.
    """
    dsn = url if (url and str(url).startswith("postgres")) else database_url()
    return PgClient(dsn)
