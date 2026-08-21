import "server-only";
import { db } from "@/lib/db";
import { revalidatePath, revalidateTag } from "next/cache";
import { tagColorKey } from "@/lib/kinds";

// Internal helpers shared across the server-action modules. NOT a "use server"
// module, so these are plain server-side functions (not exposed as actions).

export function refresh() {
  revalidatePath("/");
  revalidatePath("/trash");
  revalidatePath("/private");
  // Bust the server-side drive-data cache (see lib/items.ts) so the mutation shows up at once,
  // not after the 30s revalidate window. Both spaces: a move can shift an item across them.
  revalidateTag("drive-main");
  revalidateTag("drive-private");
}

// Resolve a tag name to a tag id, matching case-insensitively so a name that
// differs from an existing tag only in capitalization reuses that tag instead of
// creating a duplicate ("game" → existing "Game"). Creates the tag (with the given
// casing) only when no case-insensitive match exists.
export async function resolveTagId(name: string): Promise<number> {
  const n = name.trim();
  const existing = await db.execute({
    sql: "SELECT id FROM tags WHERE lower(name) = lower(?)",
    args: [n],
  });
  if (existing.rows.length) return Number(existing.rows[0].id);
  // Persist a deterministic colour at creation so it stays stable across renames.
  await db.execute({
    sql: "INSERT INTO tags (name, color) VALUES (?, ?) ON CONFLICT DO NOTHING",
    args: [n, tagColorKey(n)],
  });
  const rs = await db.execute({ sql: "SELECT id FROM tags WHERE name = ?", args: [n] });
  return Number(rs.rows[0].id);
}

export async function resolveTagIds(names: string[]): Promise<number[]> {
  const unique = [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
  if (unique.length === 0) return [];
  await db.execute({
    sql: "INSERT INTO tags (name, color) SELECT unnest(CAST(? AS text[])), unnest(CAST(? AS text[])) ON CONFLICT DO NOTHING",
    args: [unique, unique.map(tagColorKey)],
  });
  const rs = await db.execute({
    sql: "SELECT id FROM tags WHERE lower(name) = ANY(CAST(? AS text[]))",
    args: [unique.map((name) => name.toLowerCase())],
  });
  return rs.rows.map((row) => Number(row.id));
}
