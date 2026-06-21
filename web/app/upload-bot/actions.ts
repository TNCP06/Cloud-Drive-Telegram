"use server";

import { db } from "@/lib/db";
import { revalidatePath, revalidateTag } from "next/cache";
import { readFileSync } from "node:fs";

// Slug rules mirror bot/bot.py slugify(): NFKD-fold, drop non-word chars, lower,
// collapse whitespace/hyphens. Media items get a "-<msgId>" suffix so titles may repeat.
function slugify(text: string): string {
  // Strip combining diacritical marks (U+0300–U+036F) left over after NFKD folding.
  const folded = text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  let s = folded.replace(/[^\w\s-]/g, "").trim().toLowerCase();
  s = s.replace(/[-\s]+/g, "-");
  return s || "untitled";
}

interface TgThumb {
  file_id: string;
}
interface TgMessage {
  message_id: number;
  media_group_id?: number;
  caption?: string;
  document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string; thumbnail?: TgThumb };
  video?: { file_id: string; file_name?: string; file_size?: number; thumbnail?: TgThumb };
  animation?: { file_id: string; file_name?: string; file_size?: number; thumbnail?: TgThumb };
  photo?: { file_id: string; file_size?: number }[];
  [key: string]: unknown;
}

function detectKind(m: TgMessage): "media" | "archive" {
  if (m.photo || m.video || m.animation) return "media";
  if (m.document) {
    const mime: string = m.document.mime_type || "";
    if (mime.startsWith("image/") || mime.startsWith("video/")) return "media";
    return "archive";
  }
  return "media";
}

function fileMeta(m: TgMessage): { name: string | null; size: number } {
  if (m.document) return { name: m.document.file_name ?? null, size: m.document.file_size ?? 0 };
  if (m.video) return { name: m.video.file_name ?? null, size: m.video.file_size ?? 0 };
  if (m.animation) return { name: m.animation.file_name ?? null, size: m.animation.file_size ?? 0 };
  if (Array.isArray(m.photo)) return { name: null, size: m.photo[m.photo.length - 1]?.file_size ?? 0 };
  return { name: null, size: 0 };
}

function thumbFileId(m: TgMessage): string | undefined {
  return (
    m.video?.thumbnail?.file_id ??
    m.animation?.thumbnail?.file_id ??
    m.document?.thumbnail?.file_id ??
    (Array.isArray(m.photo) ? m.photo[m.photo.length - 1]?.file_id : undefined)
  );
}

async function resolveTagId(name: string): Promise<number> {
  const n = name.trim();
  const existing = await db.execute({
    sql: "SELECT id FROM tags WHERE name = ? COLLATE NOCASE",
    args: [n],
  });
  if (existing.rows.length) return Number(existing.rows[0].id);
  await db.execute({
    sql: "INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
    args: [n],
  });
  const rs = await db.execute({ sql: "SELECT id FROM tags WHERE name = ?", args: [n] });
  return Number(rs.rows[0].id);
}

// Index a channel post the web created via the bot token's copyMessage. Telegram
// does NOT send a channel_post update for the bot's OWN messages, so the bot's
// on_channel_post never fires for Bot-Drop finishes — we index inline here.
// Best-effort: a failure is logged but never reported to the user (the file is
// uploaded regardless and index_history.py back-fills it on the next watcher start).
async function indexBotDrop(
  newMsgId: number,
  title: string,
  tagNames: string[],
  apiBase: string,
  fileApiBase: string,
  telegramApiUrl: string | undefined,
  ownerId: string,
  channelId: string
): Promise<void> {
  let fwdMsgId: number | null = null;
  try {
    const fwdJson = await fetch(`${apiBase}/forwardMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ownerId, from_chat_id: channelId, message_id: newMsgId }),
    }).then((r) => r.json());

    if (!fwdJson.ok) {
      console.error("[indexBotDrop] forward failed:", fwdJson.description);
      return;
    }
    const fwd: TgMessage = fwdJson.result;
    fwdMsgId = fwd.message_id;

    const kind = detectKind(fwd);
    const { name, size } = fileMeta(fwd);
    const slug = kind === "media" ? `${slugify(title)}-${newMsgId}` : slugify(title);

    await db.execute({
      sql: `INSERT INTO items (slug, title, kind, total_parts) VALUES (?, ?, ?, 1)
            ON CONFLICT(slug) DO UPDATE SET title = excluded.title, kind = excluded.kind, updated_at = datetime('now')`,
      args: [slug, title, kind],
    });
    const itemRs = await db.execute({ sql: "SELECT id FROM items WHERE slug = ?", args: [slug] });
    const itemId = Number(itemRs.rows[0].id);

    await db.execute({
      sql: `INSERT INTO parts (item_id, part_number, channel_msg_id, file_name, file_size, uploaded_at)
            VALUES (?, 1, ?, ?, ?, datetime('now'))
            ON CONFLICT(channel_msg_id) DO UPDATE SET item_id = excluded.item_id,
              file_name = excluded.file_name, file_size = excluded.file_size`,
      args: [itemId, newMsgId, name, size],
    });
    const partRs = await db.execute({
      sql: "SELECT id FROM parts WHERE channel_msg_id = ?",
      args: [newMsgId],
    });
    const partId = Number(partRs.rows[0].id);

    await db.execute({
      sql: "UPDATE items SET total_size = (SELECT COALESCE(SUM(file_size),0) FROM parts WHERE item_id = ?) WHERE id = ?",
      args: [itemId, itemId],
    });

    for (const tn of tagNames) {
      const tagId = await resolveTagId(tn);
      await db.execute({
        sql: "INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
        args: [itemId, tagId],
      });
    }

    // Thumbnail (media only).
    if (kind === "media") {
      const tfid = thumbFileId(fwd);
      if (tfid) {
        const gf = await fetch(`${apiBase}/getFile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: tfid }),
        }).then((r) => r.json());
        if (gf.ok && gf.result?.file_path) {
          let dataB64: string | null = null;
          if (telegramApiUrl && gf.result.file_path.startsWith("/")) {
            try {
              dataB64 = readFileSync(gf.result.file_path).toString("base64");
            } catch {
              dataB64 = null;
            }
          } else {
            const dl = await fetch(`${fileApiBase}/${gf.result.file_path}`);
            if (dl.ok) dataB64 = Buffer.from(await dl.arrayBuffer()).toString("base64");
          }
          if (dataB64) {
            await db.execute({
              sql: `INSERT INTO thumbnails (part_id, mime, data) VALUES (?, 'image/jpeg', ?)
                    ON CONFLICT(part_id) DO UPDATE SET mime = excluded.mime, data = excluded.data`,
              args: [partId, dataB64],
            });
          }
        }
      }
    }

    revalidatePath("/");
    // The Bot-Drop just indexed a new item → bust the cached drive data so it appears at once.
    revalidateTag("drive-main");
  } catch (err) {
    console.error("[indexBotDrop] failed:", err);
  } finally {
    if (fwdMsgId !== null) {
      await fetch(`${apiBase}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: ownerId, message_id: fwdMsgId }),
      }).catch(() => {});
    }
  }
}

export async function processBotDrop(formData: FormData) {
  const msg_id = formData.get("msg_id")?.toString();
  const chat_id = formData.get("chat_id")?.toString();
  const title = formData.get("title")?.toString().trim();
  const tagsStr = formData.get("tags")?.toString() || "";

  if (!msg_id || !chat_id || !title) {
    return { error: "Semua data (termasuk judul) wajib diisi." };
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

  if (!BOT_TOKEN || !STORAGE_CHANNEL_ID) {
    return { error: "Konfigurasi BOT_TOKEN atau STORAGE_CHANNEL_ID di Vercel belum diisi." };
  }

  // Format caption sesuai kontrak
  const tagNames = tagsStr.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const tags = tagNames.join(", ");
  const caption = `${title} | 1/1 | ${tags}`;

  const telegramApiUrl = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
  const apiBase = `${telegramApiUrl.replace(/\/+$/, "")}/bot${BOT_TOKEN}`;
  const fileApiBase = `${telegramApiUrl.replace(/\/+$/, "")}/file/bot${BOT_TOKEN}`;

  try {
    const res = await fetch(`${apiBase}/copyMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: STORAGE_CHANNEL_ID,
        from_chat_id: chat_id,
        message_id: parseInt(msg_id, 10),
        caption: caption,
      }),
    });

    const result = await res.json();

    if (!result.ok) {
      return { error: `Telegram Error: ${result.description}` };
    }

    // Index inline (bot's own channel post yields no channel_post update). Best-effort:
    // requires OWNER_USER_ID to forward the new post and harvest metadata + thumbnail.
    const ownerId = process.env.OWNER_USER_ID;
    const newMsgId = result.result?.message_id;
    if (ownerId && typeof newMsgId === "number") {
      await indexBotDrop(
        newMsgId,
        title,
        tagNames,
        apiBase,
        fileApiBase,
        process.env.TELEGRAM_API_URL,
        ownerId,
        STORAGE_CHANNEL_ID
      );
    }

    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Gagal menghubungi Telegram." };
  }
}
