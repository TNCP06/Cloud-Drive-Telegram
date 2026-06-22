"use server";

import { db } from "@/lib/db";
import type { Tag } from "@/lib/types";
import { tagColorKey } from "@/lib/kinds";
import { refresh } from "./_shared";

// --- Category (tag) library management ---------------------------------------
// Colour is stored in tags.color (palette key, e.g. "sage"). Empty string means
// "derive from name" via tagColorKey — the fallback for old rows and for tags
// created by the bot (which doesn't know about colours).

function resolveColor(stored: string | null | undefined, name: string): string {
  const s = String(stored ?? "").trim();
  return s || tagColorKey(name);
}

export async function listTags(): Promise<Tag[]> {
  const rs = await db.execute("SELECT id, name, color FROM tags ORDER BY lower(name)");
  return rs.rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    color: resolveColor(r.color as string, String(r.name)),
  }));
}

export async function createTag(name: string, color = "") {
  const n = name.trim();
  if (!n) throw new Error("Category name cannot be empty.");
  // Don't create a near-duplicate that differs only in capitalization.
  const existing = await db.execute({
    sql: "SELECT id FROM tags WHERE lower(name) = lower(?)",
    args: [n],
  });
  if (existing.rows.length) {
    refresh();
    return;
  }
  // Persist a concrete colour at creation (chosen, or a deterministic one) so the
  // colour is stable and never shifts later (e.g. on rename).
  await db.execute({
    sql: "INSERT INTO tags (name, color) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    args: [n, color || tagColorKey(n)],
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
    sql: "SELECT id FROM tags WHERE lower(name) = lower(?) AND id != ?",
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
    // Pin the colour before renaming: if this tag has no explicit colour, lock in the
    // one currently derived from the OLD name so the rename doesn't change its hue.
    const cur = await db.execute({ sql: "SELECT name, color FROM tags WHERE id = ?", args: [id] });
    if (cur.rows.length && !String(cur.rows[0].color ?? "").trim()) {
      await db.execute({
        sql: "UPDATE tags SET color = ? WHERE id = ?",
        args: [tagColorKey(String(cur.rows[0].name)), id],
      });
    }
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
