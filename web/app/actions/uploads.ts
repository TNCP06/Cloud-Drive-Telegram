"use server";

import { rm } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { STAGING_ROOT } from "@/lib/staging";
import { revalidatePath } from "next/cache";
import type { Kind } from "@/lib/types";

// --- Upload queue (executed by watcher.py) ------------------------------------

// A staging dir may only ever be deleted when it is provably ours (inside the
// shared staging root) and never the root itself.
function isDeletableStagingDir(p: string): boolean {
  const rel = path.relative(STAGING_ROOT, path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function enqueueUpload(input: {
  kind: Kind;
  title: string;
  tags: string;
  sourcePath: string;
  partSize: number;
  isPrivate?: boolean;
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
  const isPrivate = input.isPrivate ? 1 : 0;
  await db.execute({
    sql: "INSERT INTO upload_jobs (kind, title, tags, source_path, part_size, is_private) VALUES (?, ?, ?, ?, ?, ?)",
    args: [input.kind, title, input.tags.trim(), sourcePath, input.partSize || 1500, isPrivate],
  });
  revalidatePath("/upload");
}

// Edit a queued upload job's metadata before it starts. Guarded to status='queued'
// so a running/done job can't be mutated mid-flight (the watcher already read it).
export async function updateUploadJob(
  id: number,
  input: { title: string; tags: string; partSize?: number }
) {
  const title = input.title.trim();
  if (!title) throw new Error("Title cannot be empty.");
  const tags = input.tags.trim();
  if (typeof input.partSize === "number" && input.partSize > 0) {
    await db.execute({
      sql: "UPDATE upload_jobs SET title=?, tags=?, part_size=?, updated_at=now_text() WHERE id=? AND status='queued'",
      args: [title, tags, input.partSize, id],
    });
  } else {
    await db.execute({
      sql: "UPDATE upload_jobs SET title=?, tags=?, updated_at=now_text() WHERE id=? AND status='queued'",
      args: [title, tags, id],
    });
  }
  revalidatePath("/upload");
}

export async function cancelUpload(id: number) {
  const cur = await db.execute({
    sql: "SELECT source_path, origin FROM upload_jobs WHERE id = ?",
    args: [id],
  });
  // Conditional ownership: only the caller whose UPDATE actually flips a
  // queued/pending/error row may delete staging. If the watcher claimed the
  // job in between (→ running), rowsAffected is 0 and the live staging dir is
  // left alone — deleting it would destroy an upload that is still in flight.
  const upd = await db.execute({
    sql: "UPDATE upload_jobs SET status = 'canceled', updated_at = now_text() WHERE id = ? AND status IN ('queued','pending','error')",
    args: [id],
  });
  // 'error' is included: giving up on a failed job discards its staged retry
  // copy (the backup page exposes this as "Buang"). Staging left by abandoned
  // errors is otherwise reclaimed by the watcher's 7-day error retention.
  const row = cur.rows[0] as { source_path?: unknown; origin?: unknown } | undefined;
  const dir = row ? String(row.source_path ?? "") : "";
  if (
    Number(upd.rowsAffected ?? 0) > 0 &&
    row &&
    String(row.origin ?? "") === "upload" &&
    dir &&
    isDeletableStagingDir(dir)
  ) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort: the watcher's orphan sweep reclaims it later */
    }
  }
  revalidatePath("/upload");
  revalidatePath("/backup-hp");
}

// Retry every failed job at once (backup runs can fail dozens of files on a
// flaky connection — retrying one by one is not acceptable). Keeps parts_done.
export async function retryAllFailedUploads() {
  await db.execute(
    "UPDATE upload_jobs SET status='pending', message='bulk retry requested...', updated_at=now_text() WHERE status='error'"
  );
  revalidatePath("/upload");
  revalidatePath("/backup-hp");
}

// Trigger execution: queued → pending (the watcher will pick it up).
export async function startUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status='pending', message='start requested...', updated_at=now_text() WHERE id = ? AND status='queued'",
    args: [id],
  });
  revalidatePath("/upload");
}

// Retry a failed job. Keeps parts_done so a staged upload resumes from the last
// part already pushed to Telegram instead of re-uploading everything.
export async function retryUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status='pending', message='retry requested...', updated_at=now_text() WHERE id = ? AND status='error'",
    args: [id],
  });
  revalidatePath("/upload");
  revalidatePath("/backup-hp");
}

export async function startAllUploads() {
  await db.execute(
    "UPDATE upload_jobs SET status='pending', message='start requested...', updated_at=now_text() WHERE status='queued'"
  );
  revalidatePath("/upload");
  revalidatePath("/backup-hp");
}

export async function clearFinishedUploads() {
  await db.execute(
    "DELETE FROM upload_jobs WHERE status IN ('done','error','canceled')"
  );
  revalidatePath("/upload");
  revalidatePath("/backup-hp");
}
