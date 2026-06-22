"""One-time migration: copy ALL data from the old Turso (libSQL/SQLite) database into
the new self-hosted PostgreSQL database.

Source is read over Turso's HTTP "pipeline" API with httpx (no libsql dependency, so the
bot image stays slim); target is written with psycopg. The load runs with
`session_replication_role = replica` so foreign-key order never matters, and every INSERT
is `ON CONFLICT DO NOTHING`, so the script is safe to re-run. Identity sequences are
re-synced at the end so new inserts don't collide with migrated ids.

Run ONCE, after the postgres service is up and schema.sql has been applied. On the VPS,
run it on the compose network (it can reach both Turso over the internet and postgres):

    docker compose run --rm bot python migrate_turso_to_pg.py

Required env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (source) and DATABASE_URL / POSTGRES_*
(target). After a successful migration the Turso vars can be removed from .env.
"""

import os

import httpx
import psycopg
from dotenv import load_dotenv

from pg_db import database_url

load_dotenv()

# Insert order is irrelevant (FK checks are disabled during load), but listing children
# after parents keeps the progress log readable.
TABLES = [
    "folders", "tags", "items", "parts", "item_tags", "thumbnails",
    "subtitles", "jobs", "upload_jobs", "bot_settings", "authorized_users",
]
# Tables whose `id` is a GENERATED IDENTITY → their sequence must be advanced past the
# largest migrated id.
IDENTITY_TABLES = ["folders", "items", "parts", "tags", "jobs", "upload_jobs"]


def _turso_http(url: str) -> str:
    return ("https://" + url[len("libsql://"):]) if url.startswith("libsql://") else url


def _decode(cell: dict):
    """Turso cell {"type","value"} → Python value."""
    t = cell.get("type")
    if t == "null":
        return None
    v = cell.get("value")
    if t == "integer":
        return int(v)
    if t == "float":
        return float(v)
    return v  # text (and base64 'blob') come through as strings


def turso_all(http: httpx.Client, base: str, token: str, sql: str):
    r = http.post(
        f"{base}/v2/pipeline",
        headers={"Authorization": f"Bearer {token}"} if token else {},
        json={"requests": [{"type": "execute", "stmt": {"sql": sql}}, {"type": "close"}]},
    )
    r.raise_for_status()
    res = r.json()["results"][0]
    if res["type"] != "ok":
        raise RuntimeError(res.get("error", res))
    result = res["response"]["result"]
    cols = [c["name"] for c in result["cols"]]
    rows = [[_decode(c) for c in row] for row in result["rows"]]
    return cols, rows


def main():
    base = _turso_http(os.environ["TURSO_DATABASE_URL"])
    token = os.environ.get("TURSO_AUTH_TOKEN")
    pg_dsn = database_url()

    print(f"Source : {base}")
    print(f"Target : {pg_dsn.rsplit('@', 1)[-1]}")  # host/db only, no creds
    total = 0
    with httpx.Client(timeout=120) as http, psycopg.connect(pg_dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("SET session_replication_role = replica")  # disable FK checks for the load
            for t in TABLES:
                try:
                    cols, rows = turso_all(http, base, token, f"SELECT * FROM {t}")
                except Exception as e:  # noqa: BLE001 — a missing legacy table is fine, skip it
                    print(f"  - {t}: skipped ({e})")
                    continue
                if not rows:
                    print(f"  - {t}: 0 rows")
                    continue
                collist = ", ".join(cols)
                placeholders = ", ".join(["%s"] * len(cols))
                cur.executemany(
                    f"INSERT INTO {t} ({collist}) VALUES ({placeholders}) ON CONFLICT DO NOTHING",
                    rows,
                )
                print(f"  - {t}: {len(rows)} rows")
                total += len(rows)

            for t in IDENTITY_TABLES:
                cur.execute(
                    f"SELECT setval(pg_get_serial_sequence('{t}', 'id'), "
                    f"COALESCE((SELECT MAX(id) FROM {t}), 1), "
                    f"(SELECT MAX(id) FROM {t}) IS NOT NULL)"
                )
            cur.execute("SET session_replication_role = default")

    print(f"Done. {total} rows migrated.")


if __name__ == "__main__":
    main()
