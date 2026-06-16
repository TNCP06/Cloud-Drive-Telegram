"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { Kind, Tag } from "@/lib/types";
import { tagColorKey } from "@/lib/kinds";
import { spawn } from "node:child_process";
import { openSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

// Watcher script location (default: ../bot relative to web folder). Override via env if needed.
const WATCHER_DIR = process.env.WATCHER_DIR || path.resolve(process.cwd(), "..", "bot");
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const PID_FILE = path.join(WATCHER_DIR, "watcher.pid");

// Server actions for Turso metadata (instant, without touching Telegram).
// Note: softDelete ONLY sets deleted_at. The actual file on Telegram is deleted
// at purge time (>7 days) by the bot's JobQueue → restore is lossless.

function refresh() {
  revalidatePath("/");
  revalidatePath("/trash");
}

export async function toggleFavorite(id: number, next: boolean) {
  await db.execute({
    sql: "UPDATE items SET is_favorite = ?, updated_at = datetime('now') WHERE id = ?",
    args: [next ? 1 : 0, id],
  });
  refresh();
}

export async function softDelete(id: number) {
  await db.execute({
    sql: "UPDATE items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    args: [id],
  });
  refresh();
}

export async function restore(id: number) {
  await db.execute({
    sql: "UPDATE items SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?",
    args: [id],
  });
  refresh();
}

// Edit metadata (title / kind / tags). Pure Turso operation — does NOT touch
// Telegram, the watcher, or worker.session → safe to run while an upload is in
// progress and without restarting the bot. Important: slug is intentionally NOT
// changed. The slug is the grouping key for multi-part games (ON CONFLICT during
// indexing) and the deep-link target for downloads; changing it risks conflicts
// and breaks existing links. family/version are re-derived from title on read,
// so a rename still appears in the UI.
export async function updateMetadata(
  id: number,
  input: { title: string; kind: Kind; tags: string }
) {
  const title = input.title.trim();
  if (!title) throw new Error("Title cannot be empty.");
  if (input.kind !== "game" && input.kind !== "media") {
    throw new Error("Invalid kind.");
  }

  await db.execute({
    sql: "UPDATE items SET title = ?, kind = ?, updated_at = datetime('now') WHERE id = ?",
    args: [title, input.kind, id],
  });

  // Tags: normalize (dedup, drop blanks) → upsert names → replace relations for this item.
  // Orphaned tags are not deleted to avoid racing with an ongoing upload's indexing.
  const names = Array.from(
    new Set(
      input.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    )
  );

  await db.execute({ sql: "DELETE FROM item_tags WHERE item_id = ?", args: [id] });
  for (const name of names) {
    await db.execute({
      sql: "INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
      args: [name],
    });
    const rs = await db.execute({
      sql: "SELECT id FROM tags WHERE name = ?",
      args: [name],
    });
    await db.execute({
      sql: "INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      args: [id, Number(rs.rows[0].id)],
    });
  }

  refresh();
}

// --- Category (tag) library management ---------------------------------------
// Colour is stored in tags.color (palette key, e.g. "sage"). Empty string means
// "derive from name" via tagColorKey — this is the fallback for old rows and for
// tags created by the bot (which doesn't know about colours).

function resolveColor(stored: string | null | undefined, name: string): string {
  const s = String(stored ?? "").trim();
  return s || tagColorKey(name);
}

export async function listTags(): Promise<Tag[]> {
  const rs = await db.execute("SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE");
  return rs.rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    color: resolveColor(r.color as string, String(r.name)),
  }));
}

export async function createTag(name: string, color = "") {
  const n = name.trim();
  if (!n) throw new Error("Category name cannot be empty.");
  await db.execute({
    sql: "INSERT INTO tags (name, color) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    args: [n, color],
  });
  refresh();
}

export async function recolorTag(id: number, color: string) {
  await db.execute({ sql: "UPDATE tags SET color = ? WHERE id = ?", args: [color, id] });
  refresh();
}

// Rename a tag. If another tag already owns the target name, merge into it:
// move this tag's item relations onto the existing one, then drop the duplicate.
export async function renameTag(id: number, name: string) {
  const n = name.trim();
  if (!n) throw new Error("Category name cannot be empty.");

  const existing = await db.execute({
    sql: "SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id != ?",
    args: [n, id],
  });

  if (existing.rows.length) {
    const targetId = Number(existing.rows[0].id);
    // Re-point relations; ON CONFLICT keeps the row already on the target.
    await db.execute({
      sql: "UPDATE OR IGNORE item_tags SET tag_id = ? WHERE tag_id = ?",
      args: [targetId, id],
    });
    await db.execute({ sql: "DELETE FROM item_tags WHERE tag_id = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM tags WHERE id = ?", args: [id] });
  } else {
    await db.execute({ sql: "UPDATE tags SET name = ? WHERE id = ?", args: [n, id] });
  }
  refresh();
}

// Delete a tag from the library. Relations are removed (item_tags has ON DELETE
// CASCADE, but we delete explicitly to be safe across drivers); files are untouched.
export async function deleteTag(id: number) {
  await db.execute({ sql: "DELETE FROM item_tags WHERE tag_id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM tags WHERE id = ?", args: [id] });
  refresh();
}

// Gallery: thumbnails for ALL parts of an item, ordered by album position (channel_msg_id).
// Used by PreviewDrawer to show all photos/videos in an album. Loaded on-demand
// when the drawer opens → the main grid stays light (only one cover per item).
export async function getGallery(itemId: number): Promise<string[]> {
  const rs = await db.execute({
    sql: "SELECT t.mime AS mime, t.data AS data FROM thumbnails t JOIN parts p ON p.id = t.part_id WHERE p.item_id = ? ORDER BY p.channel_msg_id",
    args: [itemId],
  });
  return rs.rows.map((r) => `data:${String(r.mime)};base64,${String(r.data)}`);
}

// --- Upload queue (executed by watcher.py on the laptop) ---
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
  // Games always require a title because it's the grouping key across parts.
  let title = input.title.trim();
  if (!title) {
    if (input.kind === "media") {
      const base = sourcePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
      title = base.replace(/\.[^.]+$/, "").trim() || "media";
    } else {
      throw new Error("Title is required for games.");
    }
  }
  await db.execute({
    sql: "INSERT INTO upload_jobs (kind, title, tags, source_path, part_size) VALUES (?, ?, ?, ?, ?)",
    args: [input.kind, title, input.tags.trim(), sourcePath, input.partSize || 1500],
  });
  revalidatePath("/upload");
}

export async function cancelUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status = 'canceled', updated_at = datetime('now') WHERE id = ? AND status IN ('queued','pending')",
    args: [id],
  });
  revalidatePath("/upload");
}

// Trigger execution: queued → pending (watcher on the laptop will pick it up).
export async function startUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status='pending', message='start requested...', updated_at=datetime('now') WHERE id = ? AND status='queued'",
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

// --- Control watcher.py process ON THE LAPTOP (web and watcher run on the same machine) ---
async function watcherOnline(): Promise<boolean> {
  try {
    const rs = await db.execute("SELECT last_seen FROM watcher_heartbeat WHERE id = 1");
    if (!rs.rows.length) return false;
    const ms = new Date(String(rs.rows[0].last_seen).replace(" ", "T") + "Z").getTime();
    return Date.now() - ms < 30000;
  } catch {
    return false;
  }
}

export async function startWatcher(): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  if (await watcherOnline()) return { ok: true, already: true };
  try {
    const out = openSync(path.join(WATCHER_DIR, "watcher.log"), "a");
    // shell:true → "python" is resolved via PATHEXT (.exe) on Windows.
    // detached + unref → watcher stays alive even if the dev server is restarted.
    const child = spawn(PYTHON_BIN, ["-u", "watcher.py"], {
      cwd: WATCHER_DIR,
      detached: true,
      windowsHide: true,
      shell: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    if (child.pid) {
      try {
        writeFileSync(PID_FILE, String(child.pid));
      } catch {
        /* ignore */
      }
      // Instant heartbeat → UI shows "active" immediately without waiting for the watcher to connect.
      await db.execute(
        "INSERT INTO watcher_heartbeat (id, last_seen, status) VALUES (1, datetime('now'), 'idle') " +
          "ON CONFLICT(id) DO UPDATE SET last_seen=datetime('now'), status='idle'"
      );
    }
    revalidatePath("/upload");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to start watcher." };
  }
}

export async function stopWatcher(): Promise<{ ok: boolean; error?: string }> {
  let pid = "";
  try {
    if (existsSync(PID_FILE)) pid = readFileSync(PID_FILE, "utf8").trim();
  } catch {
    /* ignore */
  }
  if (!pid || !/^\d+$/.test(pid)) {
    return {
      ok: false,
      error: "Watcher PID unknown (may have been started manually). Close it via the watcher window.",
    };
  }
  try {
    // /T = include child processes (7-Zip, etc.), /F = force.
    await new Promise<void>((resolve) => {
      const k = spawn("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true });
      k.on("close", () => resolve());
      k.on("error", () => resolve());
    });
    try {
      rmSync(PID_FILE);
    } catch {
      /* ignore */
    }
    // Stale heartbeat → UI shows "inactive" immediately.
    await db.execute(
      "UPDATE watcher_heartbeat SET last_seen = datetime('now','-1 hour'), status = NULL WHERE id = 1"
    );
    revalidatePath("/upload");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to stop watcher." };
  }
}
