"use server";

import { db } from "@/lib/db";
import type { GalleryPart } from "@/lib/types";
import { readFileSync } from "node:fs";
import { refresh } from "./_shared";

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

// Repair thumbnails missed at index time: forward each thumbnail-less part's channel
// message to the owner, extract the built-in thumbnail, store it, then delete the forward.
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
        const msgTypes = Object.keys(fwdMsg).filter((k) =>
          ["video", "animation", "document", "photo", "audio", "voice", "sticker"].includes(k)
        );
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
        const dlRes = await fetch(`${fileApiBase}/${gfJson.result.file_path}`);
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

  if (harvested > 0) refresh();
  return {
    ok: harvested > 0 || errors.length === 0,
    harvested,
    error: errors.length ? errors.join("; ") : undefined,
  };
}

// Manually set a base64 thumbnail for all parts of an item (fallback when Telegram
// never generated one, e.g. an unsupported codec).
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
  refresh();
  return { ok: true, updated };
}
