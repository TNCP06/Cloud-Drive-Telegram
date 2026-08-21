"use server";

import { db } from "@/lib/db";
import type { Kind } from "@/lib/types";
import { refresh, resolveTagIds } from "./_shared";
import { restoreParentChains } from "./folders";
import { authorizeItem } from "@/lib/resourceAuth";

// Item server actions for Turso metadata (instant, without touching Telegram).
// Note: softDelete ONLY sets deleted_at. The actual file on Telegram is deleted
// at purge time (>7 days) by the bot's purge job → restore is lossless.

export async function toggleFavorite(id: number, next: boolean) {
  if (!(await authorizeItem(id))) throw new Error("Item not found.");
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
  if (!(await authorizeItem(id))) throw new Error("Item not found.");
  await db.execute({
    sql: "UPDATE items SET deleted_at = now_text() WHERE id = ? AND deleted_at IS NULL",
    args: [id],
  });
  refresh();
}

export async function restore(id: number) {
  if (!(await authorizeItem(id, true))) throw new Error("Item not found.");
  const rs = await db.execute({ sql: "SELECT folder_id FROM items WHERE id = ?", args: [id] });
  if (rs.rows.length && rs.rows[0].folder_id !== null) {
    await restoreParentChains([Number(rs.rows[0].folder_id)]);
  }
  await db.execute({
    sql: "UPDATE items SET deleted_at = NULL WHERE id = ?",
    args: [id],
  });
  refresh();
}

// Delete one channel message and tombstone it.
//
// The bot can only delete its OWN posts: a part uploaded by the watcher's user account
// comes back as "Bad Request: message can't be deleted". So every purged message is
// recorded in `purged_messages` — which (a) stops index_history.py from re-indexing it
// on the next watcher restart (that is what used to make deleted files reappear) and
// (b) queues it for the watcher's Telethon account, which is allowed to delete it.
async function purgeMessage(apiBase: string, chatId: string, messageId: number) {
  let deleted = false;
  try {
    const res = await fetch(`${apiBase}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    const data = await res.json();
    deleted = Boolean(data.ok);
    if (!data.ok && data.description !== "Bad Request: message can't be deleted") {
      console.error("Telegram deleteMessage failed:", data);
    }
  } catch (err) {
    console.error("fetch deleteMessage threw:", err);
  }
  await db.execute({
    sql: `INSERT INTO purged_messages (channel_msg_id, tg_deleted) VALUES (?, ?)
          ON CONFLICT(channel_msg_id) DO UPDATE SET
            tg_deleted = GREATEST(purged_messages.tg_deleted, excluded.tg_deleted)`,
    args: [messageId, deleted ? 1 : 0],
  });
}

// Permanently delete a trashed item *now* — same effect as the bot's daily
// purge_job but on demand (no 7-day wait). Removes every part from the Telegram
// channel, then hard-deletes the DB rows (thumbnails → parts → item_tags → items).
// Guarded to items already in Trash so a stray call can't nuke a live file.
// This is irreversible: confirm in the UI before calling.
export async function purgeNow(id: number): Promise<{ ok: boolean; error?: string }> {
  if (!(await authorizeItem(id, true))) return { ok: false, error: "Item not found." };
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

  for (const row of parts.rows) {
    await purgeMessage(apiBase, STORAGE_CHANNEL_ID, Number(row.channel_msg_id));
  }

  // One statement keeps the mandatory tombstone and cascading metadata deletion atomic.
  await db.execute({
    sql: `WITH tombstones AS (
            INSERT INTO purged_messages (channel_msg_id, tg_deleted)
            SELECT channel_msg_id, 0 FROM parts WHERE item_id = ?
            ON CONFLICT(channel_msg_id) DO NOTHING
          )
          DELETE FROM items WHERE id = ?`,
    args: [id, id],
  });
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
  if (!(await authorizeItem(id))) throw new Error("Item not found.");
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

  const tagIds = await resolveTagIds(names);
  await db.execute({ sql: "DELETE FROM item_tags WHERE item_id = ?", args: [id] });
  if (tagIds.length) {
    await db.execute({
      sql: "INSERT INTO item_tags (item_id, tag_id) SELECT ?, unnest(CAST(? AS bigint[])) ON CONFLICT DO NOTHING",
      args: [id, tagIds],
    });
  }

  refresh();
}

// Queue a stored archive to be unpacked on the server (bot/unpack.py): download its parts,
// concat + 7z-extract them, and re-store each extracted file (video → streamable). The original
// archive is kept. `password` is optional and transient — the worker NULLs it the instant it
// claims the job. Returns {ok} or {ok:false, error} for a user-facing toast.
export async function unpackArchive(
  itemId: number,
  password: string
): Promise<{ ok: boolean; error?: string }> {
  if (!(await authorizeItem(itemId))) return { ok: false, error: "Item not found." };
  const it = await db.execute({
    sql: "SELECT kind FROM items WHERE id = ? AND deleted_at IS NULL",
    args: [itemId],
  });
  if (it.rows.length === 0) return { ok: false, error: "Item not found." };
  if ((it.rows[0].kind as string) !== "archive")
    return { ok: false, error: "Only archives can be unpacked." };

  const active = await db.execute({
    sql: "SELECT 1 FROM unpack_jobs WHERE item_id = ? AND status IN ('queued','running')",
    args: [itemId],
  });
  if (active.rows.length > 0)
    return { ok: false, error: "This archive is already being unpacked." };

  await db.execute({
    sql: `INSERT INTO unpack_jobs (item_id, password, status) VALUES (?, ?, 'queued')
          ON CONFLICT (item_id) WHERE status IN ('queued','running') DO NOTHING`,
    args: [itemId, password || null],
  });
  refresh();
  return { ok: true };
}

// Latest ACTIVE (queued/running) unpack job, if any — lets the drive resume its progress pill
// after a page navigation (the pill's state is client-local and dies on unmount, but the job
// keeps running server-side).
export async function getActiveUnpack(): Promise<{
  itemId: number;
  name: string;
  status: string;
  progress: number;
  message: string;
} | null> {
  const rs = await db.execute(
    "SELECT u.item_id, i.title, u.status, u.progress, u.message FROM unpack_jobs u " +
      "JOIN items i ON i.id = u.item_id WHERE u.status IN ('queued','running') " +
      "ORDER BY u.id DESC LIMIT 1"
  );
  if (!rs.rows.length) return null;
  const r = rs.rows[0];
  const title = String(r.title);
  return {
    itemId: Number(r.item_id),
    name: title.split("/").pop() || title,
    status: String(r.status),
    progress: Number(r.progress ?? 0),
    message: String(r.message ?? ""),
  };
}

// Latest unpack-job state for an item, for the drive's live progress pill. Returns null if never
// unpacked. status ∈ queued|running|done|failed; progress 0..100; message is the current step/error.
export async function getUnpackStatus(
  itemId: number
): Promise<{ status: string; progress: number; message: string } | null> {
  const rs = await db.execute({
    sql: "SELECT status, progress, message FROM unpack_jobs WHERE item_id = ? ORDER BY id DESC LIMIT 1",
    args: [itemId],
  });
  if (rs.rows.length === 0) return null;
  const r = rs.rows[0];
  return {
    status: String(r.status),
    progress: Number(r.progress ?? 0),
    message: String(r.message ?? ""),
  };
}

export async function bulkToggleFavorite(itemIds: number[], starred: boolean) {
  if (itemIds.length === 0) return;
  await db.execute({
    sql: "UPDATE items SET is_favorite = ?, updated_at = now_text() WHERE id = ANY(?)",
    args: [starred ? 1 : 0, itemIds],
  });
  refresh();
}

export async function bulkSoftDelete(itemIds: number[]) {
  if (itemIds.length === 0) return;
  await db.execute({
    sql: "UPDATE items SET deleted_at = now_text() WHERE id = ANY(?) AND deleted_at IS NULL",
    args: [itemIds],
  });
  refresh();
}

export async function bulkRestore(itemIds: number[]) {
  if (itemIds.length === 0) return;
  // Fetch distinct parent folders that need their chain untrashed.
  const rs = await db.execute({
    sql: "SELECT DISTINCT folder_id FROM items WHERE id = ANY(?) AND folder_id IS NOT NULL",
    args: [itemIds],
  });
  await restoreParentChains(rs.rows.map((row) => Number(row.folder_id)));
  await db.execute({
    sql: "UPDATE items SET deleted_at = NULL WHERE id = ANY(?)",
    args: [itemIds],
  });
  refresh();
}

export async function bulkPurgeNow(itemIds: number[]): Promise<{ ok: boolean; error?: string }> {
  if (itemIds.length === 0) return { ok: true };

  const isDemo = process.env.DEMO_MODE === "1";
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
  if (!isDemo && (!BOT_TOKEN || !STORAGE_CHANNEL_ID)) {
    return { ok: false, error: "BOT_TOKEN or STORAGE_CHANNEL_ID not set in web env." };
  }

  const telegramApiUrl = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
  const apiBase = BOT_TOKEN ? `${telegramApiUrl.replace(/\/+$/, "")}/bot${BOT_TOKEN}` : "";

  // Only purge items that are actually trashed.
  const guardRs = await db.execute({
    sql: "SELECT id FROM items WHERE id = ANY(?) AND deleted_at IS NOT NULL",
    args: [itemIds],
  });
  const validIds = guardRs.rows.map((r) => Number(r.id));
  if (validIds.length === 0) { refresh(); return { ok: true }; }

  // Delete Telegram messages for all parts of valid items.
  if (!isDemo && apiBase && STORAGE_CHANNEL_ID) {
    const parts = await db.execute({
      sql: "SELECT channel_msg_id FROM parts WHERE item_id = ANY(?)",
      args: [validIds],
    });
    for (const row of parts.rows) {
      await purgeMessage(apiBase, STORAGE_CHANNEL_ID, Number(row.channel_msg_id));
    }
  }

  // One statement atomically records every tombstone before cascading metadata deletion.
  await db.execute({
    sql: `WITH tombstones AS (
            INSERT INTO purged_messages (channel_msg_id, tg_deleted)
            SELECT channel_msg_id, ? FROM parts WHERE item_id = ANY(?)
            ON CONFLICT(channel_msg_id) DO UPDATE SET tg_deleted =
              GREATEST(purged_messages.tg_deleted, excluded.tg_deleted)
          )
          DELETE FROM items WHERE id = ANY(?)`,
    args: [isDemo ? 1 : 0, validIds, validIds],
  });

  refresh();
  return { ok: true };
}

export async function emptyTrash(): Promise<{ ok: boolean; error?: string }> {
  const itemsRs = await db.execute("SELECT id FROM items WHERE deleted_at IS NOT NULL");
  const itemIds = itemsRs.rows.map((r) => Number(r.id));
  
  if (itemIds.length > 0) {
    const res = await bulkPurgeNow(itemIds);
    if (!res.ok) return res;
  }

  await db.execute("DELETE FROM folders WHERE deleted_at IS NOT NULL");
  
  refresh();
  return { ok: true };
}
