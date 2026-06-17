import "server-only";
import { db } from "./db";
import { sqliteToMs } from "./format";
import type { Kind, UploadJob, UploadStatus } from "./types";

export async function getUploadJobs(): Promise<UploadJob[]> {
  let rs;
  try {
    rs = await db.execute(
      "SELECT id, kind, title, tags, source_path, part_size, origin, parts_done, total_bytes, status, progress, message, created_at, updated_at " +
        "FROM upload_jobs ORDER BY id DESC LIMIT 100"
    );
  } catch {
    // Momentary connection drop → return empty so /upload still renders (watcher
    // status still shows); the next poll will restore the list.
    return [];
  }
  return rs.rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind) as Kind,
    title: String(r.title),
    tags: String(r.tags ?? ""),
    sourcePath: String(r.source_path),
    partSize: Number(r.part_size),
    origin: (String(r.origin ?? "local") as "local" | "upload"),
    partsDone: Number(r.parts_done ?? 0),
    totalBytes: Number(r.total_bytes ?? 0),
    status: String(r.status) as UploadStatus,
    progress: Number(r.progress),
    message: r.message != null ? String(r.message) : null,
    createdAt: sqliteToMs(String(r.created_at)),
    updatedAt: sqliteToMs(String(r.updated_at)),
  }));
}
