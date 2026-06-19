import "server-only";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { tagColorKey } from "@/lib/kinds";

// Internal helpers shared across the server-action modules. NOT a "use server"
// module, so these are plain server-side functions (not exposed as actions).

export function refresh() {
  revalidatePath("/");
  revalidatePath("/trash");
}

// Resolve a tag name to a tag id, matching case-insensitively so a name that
// differs from an existing tag only in capitalization reuses that tag instead of
// creating a duplicate ("game" → existing "Game"). Creates the tag (with the given
// casing) only when no case-insensitive match exists.
export async function resolveTagId(name: string): Promise<number> {
  const n = name.trim();
  const existing = await db.execute({
    sql: "SELECT id FROM tags WHERE name = ? COLLATE NOCASE",
    args: [n],
  });
  if (existing.rows.length) return Number(existing.rows[0].id);
  // Persist a deterministic colour at creation so it stays stable across renames.
  await db.execute({
    sql: "INSERT INTO tags (name, color) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    args: [n, tagColorKey(n)],
  });
  const rs = await db.execute({ sql: "SELECT id FROM tags WHERE name = ?", args: [n] });
  return Number(rs.rows[0].id);
}
