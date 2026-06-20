"use server";

import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/auth";
import { refresh } from "./_shared";

// PIN-gated Private space. Items/folders with is_private = 1 live in a parallel drive
// that's hidden from the Main page and reachable only at /private after entering a PIN
// (env PIN). The PIN never reaches the client; only a SHA-256 cookie marker does.

const PRIV_COOKIE = "tcd_priv";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// True if the current request carries a valid unlock cookie (checked by /private).
export async function isPrivateUnlocked(): Promise<boolean> {
  const pin = process.env.PIN;
  if (!pin) return false; // no PIN configured → Private is effectively disabled
  const token = (await cookies()).get(PRIV_COOKIE)?.value;
  if (!token) return false;
  return timingSafeEqual(token, await sha256Hex(`priv:${pin}`));
}

// Validate a typed PIN and, on success, set the short-lived unlock cookie.
export async function unlockPrivate(pin: string): Promise<{ ok: boolean }> {
  const real = process.env.PIN;
  if (!real) return { ok: false };
  if (!timingSafeEqual(String(pin), real)) return { ok: false };
  const jar = await cookies();
  jar.set(PRIV_COOKIE, await sha256Hex(`priv:${real}`), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Session cookie (no maxAge): cleared on lock/exit so a PIN is required every access.
  });
  return { ok: true };
}

// Clear the unlock cookie — called when leaving the Private space (lock icon / brand).
export async function lockPrivate(): Promise<void> {
  (await cookies()).delete(PRIV_COOKIE);
}

// Recursively collect a folder + all descendant folder ids and the item ids within.
async function collectSubtree(
  folderId: number
): Promise<{ itemIds: number[]; folderIds: number[] }> {
  const itemIds: number[] = [];
  const folderIds: number[] = [folderId];

  const itemsRs = await db.execute({
    sql: "SELECT id FROM items WHERE folder_id = ?",
    args: [folderId],
  });
  for (const row of itemsRs.rows) itemIds.push(Number(row.id));

  const subRs = await db.execute({
    sql: "SELECT id FROM folders WHERE parent_id = ?",
    args: [folderId],
  });
  for (const row of subRs.rows) {
    const child = await collectSubtree(Number(row.id));
    itemIds.push(...child.itemIds);
    folderIds.push(...child.folderIds);
  }
  return { itemIds, folderIds };
}

// Move items between Main (makePrivate=false) and Private (makePrivate=true). Lands at
// the destination root (folder_id = NULL). Intentionally does NOT touch updated_at —
// hiding/unhiding is not a content change, so the file keeps its real Modified date.
export async function moveItemsPrivacy(itemIds: number[], makePrivate: boolean) {
  if (itemIds.length === 0) return;
  const priv = makePrivate ? 1 : 0;
  for (const id of itemIds) {
    await db.execute({
      sql: "UPDATE items SET is_private = ?, folder_id = NULL WHERE id = ?",
      args: [priv, id],
    });
  }
  refresh();
}

// Move a whole folder (and everything inside it) between Main and Private. The folder
// lands at the destination root (parent_id = NULL); descendants keep their structure.
// items.updated_at is preserved (see above).
export async function moveFolderPrivacy(folderId: number, makePrivate: boolean) {
  const priv = makePrivate ? 1 : 0;
  const { itemIds, folderIds } = await collectSubtree(folderId);

  for (const fid of folderIds) {
    await db.execute({
      sql: "UPDATE folders SET is_private = ? WHERE id = ?",
      args: [priv, fid],
    });
  }
  // Detach the top folder so it sits at the destination space's root.
  await db.execute({
    sql: "UPDATE folders SET parent_id = NULL WHERE id = ?",
    args: [folderId],
  });
  for (const id of itemIds) {
    await db.execute({
      sql: "UPDATE items SET is_private = ? WHERE id = ?",
      args: [priv, id],
    });
  }
  refresh();
}
