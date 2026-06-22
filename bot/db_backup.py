"""Daily PostgreSQL backup → Telegram, indexed into the drive under Backup / CDT DB.

A JobQueue job (scheduled in bot.py) runs pg_dump, gzips it to
`cdt-db-backup-YYYY-MM-DD.sql.gz`, uploads it to the storage channel as a document, and
indexes it via `index_bot_copy` so it appears in the dashboard under the folder path
"Backup/CDT DB" (the date is in the filename). Backups are kept forever — the dump is
tiny — and can be trashed manually from the dashboard like any other item.

Because the bot does NOT receive channel_post updates for its OWN posts, the upload is
indexed inline here (same approach as Bot Drop) instead of relying on on_channel_post.

Restore (disaster recovery), from a backup file downloaded out of the drive:
    gunzip -c cdt-db-backup-YYYY-MM-DD.sql.gz | psql "$DATABASE_URL"
"""

import asyncio
import gzip
import os
import shutil
import tempfile
from datetime import datetime, timezone

from telegram.ext import ContextTypes

from bot_config import STORAGE_CHANNEL_ID, OWNER_USER_ID, DATABASE_URL, log
from tg_helpers import slugify
from indexing import index_bot_copy

BACKUP_FOLDER = "Backup/CDT DB"
BACKUP_TAGS = ["backup"]


async def _pg_dump(out_path: str) -> None:
    """Dump the whole database to a plain-SQL file. --clean/--if-exists make the dump
    restorable over an existing database; --no-owner/--no-privileges keep it portable."""
    proc = await asyncio.create_subprocess_exec(
        "pg_dump", "--no-owner", "--no-privileges", "--clean", "--if-exists",
        "-f", out_path, DATABASE_URL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(
            f"pg_dump failed (exit {proc.returncode}): "
            f"{stderr.decode(errors='replace')[:500]}"
        )


def _gzip_file(src: str, dst: str) -> None:
    with open(src, "rb") as f_in, gzip.open(dst, "wb", compresslevel=9) as f_out:
        shutil.copyfileobj(f_in, f_out)


async def run_backup(context: ContextTypes.DEFAULT_TYPE) -> None:
    db = context.bot_data["db"]
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    stem = f"cdt-db-backup-{date_str}"
    title = f"{BACKUP_FOLDER}/{stem}"

    tmp = tempfile.mkdtemp(prefix="cdtbackup-")
    sql_path = os.path.join(tmp, f"{stem}.sql")
    gz_path = os.path.join(tmp, f"{stem}.sql.gz")
    try:
        await _pg_dump(sql_path)
        await asyncio.to_thread(_gzip_file, sql_path, gz_path)
        size = os.path.getsize(gz_path)

        caption = f"{title} | 1/1 | {', '.join(BACKUP_TAGS)}"
        with open(gz_path, "rb") as fh:
            sent = await context.bot.send_document(
                chat_id=STORAGE_CHANNEL_ID,
                document=fh,
                filename=f"{stem}.sql.gz",
                caption=caption,
            )

        await index_bot_copy(
            context, db, sent.message_id,
            title=title, tags=BACKUP_TAGS, part_number=1, total=1,
            kind="archive", slug=slugify(title), set_title=True, source_message=sent,
        )
        log.info("DB backup uploaded & indexed: %s (%.1f KB)", stem, size / 1024)
    except Exception:  # noqa: BLE001 — never let a failed backup crash the bot
        log.exception("DB backup failed")
        try:
            await context.bot.send_message(
                chat_id=OWNER_USER_ID,
                text=f"⚠️ Daily DB backup failed for {date_str}. Check bot logs.",
            )
        except Exception:  # noqa: BLE001
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
