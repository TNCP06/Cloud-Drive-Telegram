import "server-only";
import { db } from "./db";
import { sqliteToMs } from "./format";
import type { BotStatus, Kind, UploadJob, UploadStatus, WatcherStatus } from "./types";

// Watcher status from heartbeat (online if heartbeat is < 30 seconds old).
export async function getWatcherStatus(): Promise<WatcherStatus> {
  try {
    const rs = await db.execute("SELECT last_seen, status FROM watcher_heartbeat WHERE id = 1");
    if (!rs.rows.length) return { online: false, status: null, lastSeen: null };
    const lastSeen = sqliteToMs(String(rs.rows[0].last_seen));
    const status = rs.rows[0].status != null ? (String(rs.rows[0].status) as "idle" | "busy") : null;
    return { online: Date.now() - lastSeen < 30000, status, lastSeen };
  } catch {
    return { online: false, status: null, lastSeen: null };
  }
}

export async function getBotStatus(): Promise<BotStatus> {
  try {
    const rs = await db.execute("SELECT last_seen FROM bot_heartbeat WHERE id = 1");
    if (!rs.rows.length) return { online: false, lastSeen: null };
    const lastSeen = sqliteToMs(String(rs.rows[0].last_seen));
    return { online: Date.now() - lastSeen < 30000, lastSeen };
  } catch {
    return { online: false, lastSeen: null };
  }
}

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
