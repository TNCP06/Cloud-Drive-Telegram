"""Apply a .sql file to the PostgreSQL database in DATABASE_URL (default: schema.sql).

The Docker `postgres` service applies schema.sql automatically on first init, so this is
only needed for non-Docker / laptop setups where you point DATABASE_URL at your own
PostgreSQL. Idempotent: schema.sql uses CREATE … IF NOT EXISTS / CREATE OR REPLACE.

    python apply_schema.py            # applies schema.sql
    python apply_schema.py other.sql
"""

import sys

import psycopg
from dotenv import load_dotenv

from pg_db import database_url

load_dotenv()


def split_sql(sql: str):
    """Split into statements on ';', but never inside a $$ dollar-quoted block (the
    now_text() function body), and dropping full-line -- comments."""
    statements, buf, in_dollar = [], [], False
    for line in sql.splitlines():
        if not in_dollar and line.strip().startswith("--"):
            continue
        buf.append(line)
        if line.count("$$") % 2 == 1:
            in_dollar = not in_dollar
        if not in_dollar and line.rstrip().endswith(";"):
            statements.append("\n".join(buf))
            buf = []
    if "".join(buf).strip():
        statements.append("\n".join(buf))
    return [s for s in statements if s.strip()]


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "schema.sql"
    with open(path, "r", encoding="utf-8") as f:
        statements = split_sql(f.read())
    print(f"Applying {len(statements)} statement(s) from {path} …")
    with psycopg.connect(database_url(), autocommit=True) as conn:
        with conn.cursor() as cur:
            for i, stmt in enumerate(statements, 1):
                head = " ".join(stmt.split())[:70]
                print(f"  [{i}/{len(statements)}] {head}…")
                cur.execute(stmt)
    print("Schema applied.")


if __name__ == "__main__":
    main()
