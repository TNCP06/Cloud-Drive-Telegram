import "server-only";
import { db } from "./db";
import { sqliteToMs } from "./format";
import { tagColorKey } from "./kinds";
import { parseTitle } from "./version";
import type { DriveFile, Folder, Kind, Tag } from "./types";

// Fetch and shape all drive data from Turso (used by the main page and /trash).
export async function getDriveData(): Promise<{ files: DriveFile[]; tags: Tag[]; folders: Folder[] }> {
  const [itemsRs, tagsRs, itemTagsRs, thumbsRs, streamRs, foldersRs] = await Promise.all([
    db.execute(
      "SELECT id, slug, title, kind, total_parts, total_size, is_favorite, date_added, updated_at, deleted_at, folder_id FROM items"
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
    // First part info for streamable videos / media items (single or multi-part).
    db.execute(
      `WITH first_part AS (
         SELECT p.item_id, p.id AS part_id, p.file_name,
                ROW_NUMBER() OVER (PARTITION BY p.item_id ORDER BY p.channel_msg_id) AS rn
         FROM parts p JOIN items i ON i.id = p.item_id
         WHERE i.kind = 'media'
       )
       SELECT item_id, part_id, file_name FROM first_part WHERE rn = 1`
    ),
    db.execute("SELECT id, name, parent_id, created_at, updated_at FROM folders ORDER BY name COLLATE NOCASE"),
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

  // Map item_id → { partId, fileName } for streamable single-part media.
  const streamByItem = new Map<number, { partId: number; fileName: string }>();
  for (const r of streamRs.rows) {
    streamByItem.set(Number(r.item_id), {
      partId: Number(r.part_id),
      fileName: String(r.file_name ?? ""),
    });
  }

  const files: DriveFile[] = itemsRs.rows.map((r) => {
    const id = Number(r.id);
    const name = String(r.title);
    const kind = String(r.kind) as Kind;
    const deletedAt = r.deleted_at ? sqliteToMs(String(r.deleted_at)) : null;
    // Version grouping is only relevant for archives (media has no version).
    const tp =
      kind === "archive"
        ? parseTitle(name)
        : { family: name, familyKey: String(r.slug), version: null };
    const stream = streamByItem.get(id);
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
      firstPartId: stream?.partId ?? null,
      fileName: stream?.fileName ?? null,
      family: tp.family,
      familyKey: tp.familyKey,
      version: tp.version,
      folderId: r.folder_id ? Number(r.folder_id) : null,
    };
  });

  const folders: Folder[] = foldersRs.rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    parentId: r.parent_id ? Number(r.parent_id) : null,
    createdAt: sqliteToMs(String(r.created_at)),
    updatedAt: sqliteToMs(String(r.updated_at)),
  }));

  return { files, tags, folders };
}

