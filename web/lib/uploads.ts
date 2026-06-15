import "server-only";
import { db } from "./db";
import { sqliteToMs } from "./format";
import type { Kind, UploadJob, UploadStatus, WatcherStatus } from "./types";

// Status watcher dari heartbeat (online jika denyut < 30 detik lalu).
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

export async function getUploadJobs(): Promise<UploadJob[]> {
  let rs;
  try {
    rs = await db.execute(
      "SELECT id, kind, title, tags, source_path, part_size, status, progress, message, created_at, updated_at " +
        "FROM upload_jobs ORDER BY id DESC LIMIT 100"
    );
  } catch {
    // Koneksi sesaat putus → kembalikan kosong agar /upload tetap render (status watcher
    // tetap tampil); polling berikutnya memulihkan daftar.
    return [];
  }
  return rs.rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind) as Kind,
    title: String(r.title),
    tags: String(r.tags ?? ""),
    sourcePath: String(r.source_path),
    partSize: Number(r.part_size),
    status: String(r.status) as UploadStatus,
    progress: Number(r.progress),
    message: r.message != null ? String(r.message) : null,
    createdAt: sqliteToMs(String(r.created_at)),
    updatedAt: sqliteToMs(String(r.updated_at)),
  }));
}
