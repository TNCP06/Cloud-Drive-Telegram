import "server-only";
import { db } from "./db";
import { sqliteToMs } from "./format";
import { tagColorKey } from "./kinds";
import { parseTitle } from "./version";
import type { DriveFile, Kind, Tag } from "./types";

// Fetch and shape all drive data from Turso (used by the main page and /trash).
export async function getDriveData(): Promise<{ files: DriveFile[]; tags: Tag[] }> {
  const [itemsRs, tagsRs, itemTagsRs, thumbsRs] = await Promise.all([
    db.execute(
      "SELECT id, slug, title, kind, total_parts, total_size, is_favorite, date_added, updated_at, deleted_at FROM items"
    ),
    db.execute("SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE"),
    db.execute("SELECT it.item_id AS item_id, it.tag_id AS tag_id FROM item_tags it"),
    // Cover = thumbnail of the FIRST PART of each item (album = smallest channel_msg_id).
    // Full gallery is loaded on-demand in PreviewDrawer via getGallery().
    db.execute(
      `WITH cover AS (
         SELECT p.item_id AS item_id, t.mime AS mime, t.data AS data,
                ROW_NUMBER() OVER (PARTITION BY p.item_id ORDER BY p.channel_msg_id) AS rn
         FROM thumbnails t JOIN parts p ON p.id = t.part_id
       )
       SELECT item_id, mime, data FROM cover WHERE rn = 1`
    ),
  ]);

  const tags: Tag[] = tagsRs.rows.map((r) => {
    const stored = String(r.color ?? "").trim();
    return {
      id: Number(r.id),
      name: String(r.name),
      color: stored || tagColorKey(String(r.name)),
    };
  });

  const tagsByItem = new Map<number, number[]>();
  for (const r of itemTagsRs.rows) {
    const itemId = Number(r.item_id);
    const list = tagsByItem.get(itemId) ?? [];
    list.push(Number(r.tag_id));
    tagsByItem.set(itemId, list);
  }

  const thumbByItem = new Map<number, string>();
  for (const r of thumbsRs.rows) {
    thumbByItem.set(Number(r.item_id), `data:${String(r.mime)};base64,${String(r.data)}`);
  }

  const files: DriveFile[] = itemsRs.rows.map((r) => {
    const id = Number(r.id);
    const name = String(r.title);
    const kind = String(r.kind) as Kind;
    const deletedAt = r.deleted_at ? sqliteToMs(String(r.deleted_at)) : null;
    // Version grouping is only relevant for games (media has no version).
    const tp =
      kind === "game"
        ? parseTitle(name)
        : { family: name, familyKey: String(r.slug), version: null };
    return {
      id,
      slug: String(r.slug),
      name,
      kind,
      size: Number(r.total_size),
      parts: Number(r.total_parts),
      modified: sqliteToMs(String(r.updated_at)),
      added: sqliteToMs(String(r.date_added)),
      tags: tagsByItem.get(id) ?? [],
      starred: Number(r.is_favorite) === 1,
      trashed: deletedAt != null,
      deletedAt,
      thumb: thumbByItem.get(id) ?? null,
      family: tp.family,
      familyKey: tp.familyKey,
      version: tp.version,
    };
  });

  return { files, tags };
}
