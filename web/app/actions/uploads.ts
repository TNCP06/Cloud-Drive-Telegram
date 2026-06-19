"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { Kind } from "@/lib/types";

// --- Upload queue (executed by watcher.py) ------------------------------------

export async function enqueueUpload(input: {
  kind: Kind;
  title: string;
  tags: string;
  sourcePath: string;
  partSize: number;
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
  await db.execute({
    sql: "INSERT INTO upload_jobs (kind, title, tags, source_path, part_size) VALUES (?, ?, ?, ?, ?)",
    args: [input.kind, title, input.tags.trim(), sourcePath, input.partSize || 1500],
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
      sql: "UPDATE upload_jobs SET title=?, tags=?, part_size=?, updated_at=datetime('now') WHERE id=? AND status='queued'",
      args: [title, tags, input.partSize, id],
    });
  } else {
    await db.execute({
      sql: "UPDATE upload_jobs SET title=?, tags=?, updated_at=datetime('now') WHERE id=? AND status='queued'",
      args: [title, tags, id],
    });
  }
  revalidatePath("/upload");
}

export async function cancelUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status = 'canceled', updated_at = datetime('now') WHERE id = ? AND status IN ('queued','pending')",
    args: [id],
  });
  revalidatePath("/upload");
}

// Trigger execution: queued → pending (the watcher will pick it up).
export async function startUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status='pending', message='start requested...', updated_at=datetime('now') WHERE id = ? AND status='queued'",
    args: [id],
  });
  revalidatePath("/upload");
}

// Retry a failed job. Keeps parts_done so a staged upload resumes from the last
// part already pushed to Telegram instead of re-uploading everything.
export async function retryUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status='pending', message='retry requested...', updated_at=datetime('now') WHERE id = ? AND status='error'",
    args: [id],
  });
  revalidatePath("/upload");
}

export async function startAllUploads() {
  await db.execute(
    "UPDATE upload_jobs SET status='pending', message='start requested...', updated_at=datetime('now') WHERE status='queued'"
  );
  revalidatePath("/upload");
}

export async function clearFinishedUploads() {
  await db.execute(
    "DELETE FROM upload_jobs WHERE status IN ('done','error','canceled')"
  );
  revalidatePath("/upload");
}
