"use server";

import { db } from "@/lib/db";
import type { Kind } from "@/lib/types";
import { refresh, resolveTagId } from "./_shared";

// Item server actions for Turso metadata (instant, without touching Telegram).
// Note: softDelete ONLY sets deleted_at. The actual file on Telegram is deleted
// at purge time (>7 days) by the bot's purge job → restore is lossless.

export async function toggleFavorite(id: number, next: boolean) {
  await db.execute({
    sql: "UPDATE items SET is_favorite = ?, updated_at = now_text() WHERE id = ?",
    args: [next ? 1 : 0, id],
  });
  refresh();
}

// Soft delete / restore intentionally do NOT touch updated_at: trashing is not a
// content change, and `date_added`/`updated_at` (= the UI's "Added"/"Modified" and
// the default sort key) must survive the round-trip so a restored item returns to
// its original position instead of looking freshly uploaded. Trash status is
// tracked solely by `deleted_at`.
export async function softDelete(id: number) {
  await db.execute({
    sql: "UPDATE items SET deleted_at = now_text() WHERE id = ? AND deleted_at IS NULL",
    args: [id],
  });
  refresh();
}

export async function restore(id: number) {
  await db.execute({
    sql: "UPDATE items SET deleted_at = NULL WHERE id = ?",
    args: [id],
  });
  refresh();
}

// Permanently delete a trashed item *now* — same effect as the bot's daily
// purge_job but on demand (no 7-day wait). Removes every part from the Telegram
// channel, then hard-deletes the DB rows (thumbnails → parts → item_tags → items).
// Guarded to items already in Trash so a stray call can't nuke a live file.
// This is irreversible: confirm in the UI before calling.
export async function purgeNow(id: number): Promise<{ ok: boolean; error?: string }> {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
  if (!BOT_TOKEN || !STORAGE_CHANNEL_ID) {
    return { ok: false, error: "BOT_TOKEN or STORAGE_CHANNEL_ID not set in web env." };
  }

  const guard = await db.execute({
    sql: "SELECT id FROM items WHERE id = ? AND deleted_at IS NOT NULL",
    args: [id],
  });
  if (!guard.rows.length) {
    return { ok: false, error: "Item is not in Trash." };
  }

  const telegramApiUrl = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
  const apiBase = `${telegramApiUrl.replace(/\/+$/, "")}/bot${BOT_TOKEN}`;
  const parts = await db.execute({
    sql: "SELECT channel_msg_id FROM parts WHERE item_id = ?",
    args: [id],
  });

  // Best-effort Telegram deletes — a message may already be gone; keep going so
  // the DB rows are still cleaned up regardless.
  for (const row of parts.rows) {
    await fetch(`${apiBase}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: STORAGE_CHANNEL_ID, message_id: Number(row[0]) }),
    }).catch(() => {});
  }

  // Explicit hard delete (thumbnails FK → parts, so delete thumbnails first).
  await db.execute({
    sql: "DELETE FROM thumbnails WHERE part_id IN (SELECT id FROM parts WHERE item_id = ?)",
    args: [id],
  });
  await db.execute({ sql: "DELETE FROM parts WHERE item_id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM item_tags WHERE item_id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM items WHERE id = ?", args: [id] });
  refresh();
  return { ok: true };
}

// Edit metadata (title / kind / tags). Pure Turso operation — does NOT touch
// Telegram, the watcher, or worker.session → safe to run while an upload is in
// progress and without restarting the bot. Important: slug is intentionally NOT
// changed. The slug is the grouping key for multi-part archives (ON CONFLICT during
// indexing) and the deep-link target for downloads; changing it risks conflicts
// and breaks existing links. family/version are re-derived from title on read,
// so a rename still appears in the UI.
export async function updateMetadata(
  id: number,
  input: { title: string; kind: Kind; tags: string }
) {
  const title = input.title.trim();
  if (!title) throw new Error("Title cannot be empty.");
  if (input.kind !== "archive" && input.kind !== "media") {
    throw new Error("Invalid kind.");
  }

  await db.execute({
    sql: "UPDATE items SET title = ?, kind = ?, updated_at = now_text() WHERE id = ?",
    args: [title, input.kind, id],
  });

  // Tags: normalize (dedup, drop blanks) → upsert names → replace relations for this item.
  // Orphaned tags are not deleted to avoid racing with an ongoing upload's indexing.
  const names = Array.from(
    new Set(
      input.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    )
  );

  await db.execute({ sql: "DELETE FROM item_tags WHERE item_id = ?", args: [id] });
  for (const name of names) {
    const tagId = await resolveTagId(name);
    await db.execute({
      sql: "INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      args: [id, tagId],
    });
  }

  refresh();
}

export async function bulkToggleFavorite(itemIds: number[], starred: boolean) {
  if (itemIds.length === 0) return;
  for (const itemId of itemIds) {
    await db.execute({
      sql: "UPDATE items SET is_favorite = ?, updated_at = now_text() WHERE id = ?",
      args: [starred ? 1 : 0, itemId],
    });
  }
  refresh();
}

export async function bulkSoftDelete(itemIds: number[]) {
  if (itemIds.length === 0) return;
  for (const itemId of itemIds) {
    await db.execute({
      sql: "UPDATE items SET deleted_at = now_text() WHERE id = ? AND deleted_at IS NULL",
      args: [itemId],
    });
  }
  refresh();
}

export async function bulkRestore(itemIds: number[]) {
  if (itemIds.length === 0) return;
  for (const itemId of itemIds) {
    await db.execute({
      sql: "UPDATE items SET deleted_at = NULL WHERE id = ?",
      args: [itemId],
    });
  }
  refresh();
}

export async function bulkPurgeNow(itemIds: number[]): Promise<{ ok: boolean; error?: string }> {
  if (itemIds.length === 0) return { ok: true };

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
  if (!BOT_TOKEN || !STORAGE_CHANNEL_ID) {
    return { ok: false, error: "BOT_TOKEN or STORAGE_CHANNEL_ID not set in web env." };
  }

  const telegramApiUrl = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
  const apiBase = `${telegramApiUrl.replace(/\/+$/, "")}/bot${BOT_TOKEN}`;

  for (const id of itemIds) {
    const guard = await db.execute({
      sql: "SELECT id FROM items WHERE id = ? AND deleted_at IS NOT NULL",
      args: [id],
    });
    if (!guard.rows.length) continue;

    const parts = await db.execute({
      sql: "SELECT channel_msg_id FROM parts WHERE item_id = ?",
      args: [id],
    });

    for (const row of parts.rows) {
      await fetch(`${apiBase}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: STORAGE_CHANNEL_ID, message_id: Number(row[0]) }),
      }).catch(() => {});
    }

    await db.execute({
      sql: "DELETE FROM thumbnails WHERE part_id IN (SELECT id FROM parts WHERE item_id = ?)",
      args: [id],
    });
    await db.execute({ sql: "DELETE FROM parts WHERE item_id = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM item_tags WHERE item_id = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM items WHERE id = ?", args: [id] });
  }

  refresh();
  return { ok: true };
}
