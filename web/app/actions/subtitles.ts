"use server";

import { db } from "@/lib/db";

// Subtitle files stored on the drive (Telegram storage) that can be attached to a
// video — picked in the SubtitleDialog's "from drive" tab.
export interface DriveSubtitleFile {
  partId: number;
  fileName: string;
  itemName: string;
  size: number;
}

export async function listDriveSubtitleFiles(): Promise<DriveSubtitleFile[]> {
  const rs = await db.execute({
    sql: `SELECT p.id AS part_id, p.file_name, p.file_size, i.title
          FROM parts p JOIN items i ON i.id = p.item_id
          WHERE i.deleted_at IS NULL AND i.is_private = 0
            AND (lower(p.file_name) LIKE '%.srt' OR lower(p.file_name) LIKE '%.vtt'
              OR lower(p.file_name) LIKE '%.ass' OR lower(p.file_name) LIKE '%.ssa'
              OR lower(p.file_name) LIKE '%.sub')
          ORDER BY i.title, p.file_name`,
    args: [],
  });
  return rs.rows.map((r) => ({
    partId: Number(r.part_id),
    fileName: String(r.file_name ?? ""),
    itemName: String(r.title ?? ""),
    size: Number(r.file_size ?? 0),
  }));
}
