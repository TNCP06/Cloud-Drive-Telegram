"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { GalleryPart, Kind, Tag } from "@/lib/types";
import { tagColorKey } from "@/lib/kinds";
import { readFileSync } from "node:fs";


// Server actions for Turso metadata (instant, without touching Telegram).
// Note: softDelete ONLY sets deleted_at. The actual file on Telegram is deleted
// at purge time (>7 days) by the bot's JobQueue → restore is lossless.

function refresh() {
  revalidatePath("/");
  revalidatePath("/trash");
}

export async function toggleFavorite(id: number, next: boolean) {
  await db.execute({
    sql: "UPDATE items SET is_favorite = ?, updated_at = datetime('now') WHERE id = ?",
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
    sql: "UPDATE items SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
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
    sql: "UPDATE items SET title = ?, kind = ?, updated_at = datetime('now') WHERE id = ?",
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
    await db.execute({
      sql: "INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
      args: [name],
    });
    const rs = await db.execute({
      sql: "SELECT id FROM tags WHERE name = ?",
      args: [name],
    });
    await db.execute({
      sql: "INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      args: [id, Number(rs.rows[0].id)],
    });
  }

  refresh();
}

// --- Category (tag) library management ---------------------------------------
// Colour is stored in tags.color (palette key, e.g. "sage"). Empty string means
// "derive from name" via tagColorKey — this is the fallback for old rows and for
// tags created by the bot (which doesn't know about colours).

function resolveColor(stored: string | null | undefined, name: string): string {
  const s = String(stored ?? "").trim();
  return s || tagColorKey(name);
}

export async function listTags(): Promise<Tag[]> {
  const rs = await db.execute("SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE");
  return rs.rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    color: resolveColor(r.color as string, String(r.name)),
  }));
}

export async function createTag(name: string, color = "") {
  const n = name.trim();
  if (!n) throw new Error("Category name cannot be empty.");
  await db.execute({
    sql: "INSERT INTO tags (name, color) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    args: [n, color],
  });
  refresh();
}

export async function recolorTag(id: number, color: string) {
  await db.execute({ sql: "UPDATE tags SET color = ? WHERE id = ?", args: [color, id] });
  refresh();
}

// Rename a tag. If another tag already owns the target name, merge into it:
// move this tag's item relations onto the existing one, then drop the duplicate.
export async function renameTag(id: number, name: string) {
  const n = name.trim();
  if (!n) throw new Error("Category name cannot be empty.");

  const existing = await db.execute({
    sql: "SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id != ?",
    args: [n, id],
  });

  if (existing.rows.length) {
    const targetId = Number(existing.rows[0].id);
    // Re-point relations; ON CONFLICT keeps the row already on the target.
    await db.execute({
      sql: "UPDATE OR IGNORE item_tags SET tag_id = ? WHERE tag_id = ?",
      args: [targetId, id],
    });
    await db.execute({ sql: "DELETE FROM item_tags WHERE tag_id = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM tags WHERE id = ?", args: [id] });
  } else {
    await db.execute({ sql: "UPDATE tags SET name = ? WHERE id = ?", args: [n, id] });
  }
  refresh();
}

// Delete a tag from the library. Relations are removed (item_tags has ON DELETE
// CASCADE, but we delete explicitly to be safe across drivers); files are untouched.
export async function deleteTag(id: number) {
  await db.execute({ sql: "DELETE FROM item_tags WHERE tag_id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM tags WHERE id = ?", args: [id] });
  refresh();
}

// Gallery: thumbnails for ALL parts of an item, ordered by album position (channel_msg_id).
// Used by PreviewDrawer to show all photos/videos in an album. Loaded on-demand
// when the drawer opens → the main grid stays light (only one cover per item).
export async function getGallery(itemId: number): Promise<GalleryPart[]> {
  const rs = await db.execute({
    sql: `SELECT p.id AS part_id, p.file_name, t.mime, t.data 
          FROM parts p 
          LEFT JOIN thumbnails t ON p.id = t.part_id 
          WHERE p.item_id = ? 
          ORDER BY p.channel_msg_id`,
    args: [itemId],
  });

  return rs.rows.map((r) => ({
    partId: Number(r.part_id),
    fileName: r.file_name ? String(r.file_name) : null,
    thumb: r.data ? `data:${String(r.mime)};base64,${String(r.data)}` : null,
  }));
}

// --- Upload queue (executed by watcher.py on the laptop) ---
export async function enqueueUpload(input: {
  kind: Kind;
  title: string;
  tags: string;
  sourcePath: string;
  partSize: number;
}) {
  const sourcePath = input.sourcePath.trim();
  if (!sourcePath) throw new Error("File path on the laptop is required.");
  // Media (images/small files) may have no title → derive from filename.
  // Archives always require a title because it's the grouping key across parts.
  let title = input.title.trim();
  if (!title) {
    if (input.kind === "media") {
      const base = sourcePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
      title = base.replace(/\.[^.]+$/, "").trim() || "media";
    } else {
      throw new Error("Title is required for archives.");
    }
  }
  await db.execute({
    sql: "INSERT INTO upload_jobs (kind, title, tags, source_path, part_size) VALUES (?, ?, ?, ?, ?)",
    args: [input.kind, title, input.tags.trim(), sourcePath, input.partSize || 1500],
  });
  revalidatePath("/upload");
}

export async function cancelUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status = 'canceled', updated_at = datetime('now') WHERE id = ? AND status IN ('queued','pending')",
    args: [id],
  });
  revalidatePath("/upload");
}

// Trigger execution: queued → pending (watcher on the laptop will pick it up).
export async function startUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status='pending', message='start requested...', updated_at=datetime('now') WHERE id = ? AND status='queued'",
    args: [id],
  });
  revalidatePath("/upload");
}

// Retry a failed job. Keeps parts_done so a staged upload resumes from the last
// part already pushed to Telegram instead of re-uploading everything.
export async function retryUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status='pending', message='retry requested...', updated_at=datetime('now') WHERE id = ? AND status='error'",
    args: [id],
  });
  revalidatePath("/upload");
}

export async function startAllUploads() {
  await db.execute(
    "UPDATE upload_jobs SET status='pending', message='start requested...', updated_at=datetime('now') WHERE status='queued'"
  );
  revalidatePath("/upload");
}

export async function clearFinishedUploads() {
  await db.execute(
    "DELETE FROM upload_jobs WHERE status IN ('done','error','canceled')"
  );
  revalidatePath("/upload");
}


export async function reharvestThumbnail(
  itemId: number
): Promise<{ ok: boolean; harvested: number; error?: string }> {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
  const OWNER_USER_ID = process.env.OWNER_USER_ID;

  if (!BOT_TOKEN || !STORAGE_CHANNEL_ID || !OWNER_USER_ID) {
    return {
      ok: false,
      harvested: 0,
      error: "BOT_TOKEN, STORAGE_CHANNEL_ID, or OWNER_USER_ID not set in web env.",
    };
  }

  // Only fetch parts that have no thumbnail yet.
  const rs = await db.execute({
    sql: `SELECT p.id, p.channel_msg_id FROM parts p
     LEFT JOIN thumbnails t ON t.part_id = p.id
     WHERE p.item_id = ? AND t.part_id IS NULL
     ORDER BY p.part_number`,
    args: [itemId],
  });
  if (!rs.rows.length) return { ok: true, harvested: 0 };

  const telegramApiUrl = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
  const apiBase = `${telegramApiUrl.replace(/\/+$/, "")}/bot${BOT_TOKEN}`;
  const fileApiBase = `${telegramApiUrl.replace(/\/+$/, "")}/file/bot${BOT_TOKEN}`;
  let harvested = 0;
  const errors: string[] = [];

  for (const row of rs.rows) {
    const partId = Number(row[0]);
    const channelMsgId = Number(row[1]);
    let fwdMsgId: number | null = null;
    try {
      // forwardMessage returns a full Message object (unlike copyMessage which only returns MessageId).
      const fwdJson = await fetch(`${apiBase}/forwardMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: OWNER_USER_ID,
          from_chat_id: STORAGE_CHANNEL_ID,
          message_id: channelMsgId,
        }),
      }).then((r) => r.json());

      if (!fwdJson.ok) {
        const msg = `Forward failed for msg ${channelMsgId}: ${fwdJson.description}`;
        console.error("[reharvestThumbnail]", msg);
        errors.push(msg);
        continue;
      }
      const fwdMsg = fwdJson.result;
      fwdMsgId = fwdMsg.message_id;

      const thumbFileId: string | undefined =
        fwdMsg.video?.thumbnail?.file_id ??
        fwdMsg.animation?.thumbnail?.file_id ??
        fwdMsg.document?.thumbnail?.file_id ??
        (Array.isArray(fwdMsg.photo) ? fwdMsg.photo[fwdMsg.photo.length - 1]?.file_id : undefined);

      if (!thumbFileId) {
        const msgTypes = Object.keys(fwdMsg).filter(k => ["video","animation","document","photo","audio","voice","sticker"].includes(k));
        const msg = `No thumbnail in msg ${channelMsgId} (type: ${msgTypes.join(",") || "unknown"})`;
        console.error("[reharvestThumbnail]", msg, JSON.stringify(fwdMsg).slice(0, 300));
        errors.push(msg);
        continue;
      }

      const gfJson = await fetch(`${apiBase}/getFile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: thumbFileId }),
      }).then((r) => r.json());

      if (!gfJson.ok || !gfJson.result?.file_path) {
        errors.push(`getFile failed for msg ${channelMsgId}`);
        continue;
      }

      let data_b64: string;
      if (telegramApiUrl && gfJson.result.file_path.startsWith("/")) {
        try {
          data_b64 = readFileSync(gfJson.result.file_path).toString("base64");
        } catch (err) {
          errors.push(`Read local file failed for msg ${channelMsgId}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
      } else {
        const dlRes = await fetch(
          `${fileApiBase}/${gfJson.result.file_path}`
        );
        if (!dlRes.ok) {
          errors.push(`Download failed for msg ${channelMsgId}`);
          continue;
        }
        data_b64 = Buffer.from(await dlRes.arrayBuffer()).toString("base64");
      }
      await db.execute({
        sql: `INSERT INTO thumbnails (part_id, mime, data) VALUES (?, ?, ?)
         ON CONFLICT(part_id) DO UPDATE SET mime = excluded.mime, data = excluded.data`,
        args: [partId, "image/jpeg", data_b64],
      });
      harvested++;
    } finally {
      // Always clean up the forwarded message to avoid cluttering the owner's chat.
      if (fwdMsgId !== null) {
        await fetch(`${apiBase}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: OWNER_USER_ID, message_id: fwdMsgId }),
        }).catch(() => {});
      }
    }
  }

  if (harvested > 0) revalidatePath("/");
  return {
    ok: harvested > 0 || errors.length === 0,
    harvested,
    error: errors.length ? errors.join("; ") : undefined,
  };
}

export async function uploadThumbnail(
  itemId: number,
  mime: string,
  dataB64: string
): Promise<{ ok: boolean; updated: number; error?: string }> {
  if (dataB64.length > 750_000) {
    return { ok: false, updated: 0, error: "Image too large (max ~500 KB)." };
  }
  const rs = await db.execute({
    sql: "SELECT id FROM parts WHERE item_id = ? ORDER BY channel_msg_id",
    args: [itemId],
  });
  if (!rs.rows.length) {
    return { ok: false, updated: 0, error: "No parts found for this item." };
  }
  let updated = 0;
  for (const row of rs.rows) {
    const partId = Number(row[0]);
    await db.execute({
      sql: `INSERT INTO thumbnails (part_id, mime, data) VALUES (?, ?, ?)
            ON CONFLICT(part_id) DO UPDATE SET mime = excluded.mime, data = excluded.data`,
      args: [partId, mime, dataB64],
    });
    updated++;
  }
  revalidatePath("/");
  return { ok: true, updated };
}


