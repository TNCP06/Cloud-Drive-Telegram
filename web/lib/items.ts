import "server-only";
import { unstable_cache } from "next/cache";
import { db } from "./db";
import { sqliteToMs } from "./format";
import { tagColorKey } from "./kinds";
import { parseTitle } from "./version";
import type { DriveFile, Folder, Kind, Tag } from "./types";

// Fetch and shape all drive data from Turso (used by the main page and /trash).
//
// `space` partitions the drive into the public Main view (is_private = 0) and the
// PIN-gated Private view (is_private = 1). Items/folders are filtered by it, and the
// tag list only includes tags still used by ≥1 item IN THIS SPACE — so a tag whose
// last file moved to Private disappears from Main (and vice-versa). Private items are
// never sent to the Main page, so their sizes/tags/analytics are hidden there for free.
//
// The shaped result is cached server-side (`unstable_cache`, 30s window) so repeat loads and
// navigations don't re-run these six Turso queries every request. Web mutations bust it instantly
// via `revalidateTag("drive-<space>")` (see actions/_shared.ts); anything written by the bot shows
// up within the window. Pages stay `force-dynamic` so the DB is never queried at build time.
export function getDriveData(
  space: "main" | "private" = "main"
): Promise<{ files: DriveFile[]; tags: Tag[]; folders: Folder[] }> {
  return unstable_cache(() => fetchDriveData(space), ["drive-data", space], {
    revalidate: 30,
    tags: [`drive-${space}`],
  })();
}

async function fetchDriveData(
  space: "main" | "private"
): Promise<{ files: DriveFile[]; tags: Tag[]; folders: Folder[] }> {
  const priv = space === "private" ? 1 : 0;
  const [itemsRs, tagsRs, itemTagsRs, thumbsRs, streamRs, foldersRs] = await Promise.all([
    db.execute(
      `SELECT id, slug, title, kind, total_parts, total_size, is_favorite, date_added, updated_at, deleted_at, folder_id FROM items WHERE is_private = ${priv}`
    ),
    db.execute(
      `SELECT id, name, color FROM tags
       WHERE id IN (SELECT DISTINCT it.tag_id FROM item_tags it JOIN items i ON i.id = it.item_id WHERE i.is_private = ${priv})
       ORDER BY lower(name)`
    ),
    db.execute(
      `SELECT it.item_id AS item_id, it.tag_id AS tag_id FROM item_tags it
       JOIN items i ON i.id = it.item_id WHERE i.is_private = ${priv}`
    ),
    // Which items HAVE a cover thumbnail (first part = smallest channel_msg_id). We only fetch
    // existence here, not the bytes: the cover image itself is served lazily & HTTP-cached via
    // /api/thumb/[itemId], so the page payload stays tiny even with a huge library. The full
    // gallery is loaded on-demand in PreviewDrawer via getGallery().
    db.execute(
      `SELECT DISTINCT p.item_id AS item_id
       FROM thumbnails t JOIN parts p ON p.id = t.part_id`
    ),
    // First part info for EVERY item (single or multi-part). Media uses it for video
    // streaming; non-media uses the first part's file_name to derive a fine-grained
    // document type (PDF/Word/Excel/…) and to drive inline document preview.
    db.execute(
      `WITH first_part AS (
         SELECT p.item_id, p.id AS part_id, p.file_name,
                ROW_NUMBER() OVER (PARTITION BY p.item_id ORDER BY p.channel_msg_id) AS rn
         FROM parts p
       )
       SELECT item_id, part_id, file_name FROM first_part WHERE rn = 1`
    ),
    db.execute(`SELECT id, name, parent_id, created_at, updated_at FROM folders WHERE is_private = ${priv} ORDER BY lower(name)`),
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

  const haveCover = new Set<number>();
  for (const r of thumbsRs.rows) {
    haveCover.add(Number(r.item_id));
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
      thumb: haveCover.has(id) ? `/api/thumb/${id}` : null,
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

