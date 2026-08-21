import "server-only";

import { cookies } from "next/headers";
import { db } from "./db";
import { sha256Hex } from "./auth";

async function canReadSpace(isPrivate: number): Promise<boolean> {
  if (isPrivate !== 1) return true;
  const pin = process.env.PIN;
  if (!pin) return false;
  const token = (await cookies()).get("tcd_priv")?.value;
  return !!token && token === (await sha256Hex(`priv:${pin}`));
}

export async function authorizeItem(itemId: number, includeDeleted = false): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT is_private, deleted_at FROM items WHERE id = ?",
    args: [itemId],
  });
  const row = rs.rows[0];
  return !!row && (includeDeleted || !row.deleted_at) && canReadSpace(Number(row.is_private ?? 0));
}

export async function authorizePart(partId: number, includeDeleted = false): Promise<boolean> {
  const rs = await db.execute({
    sql: `SELECT i.is_private, i.deleted_at
          FROM parts p JOIN items i ON i.id = p.item_id
          WHERE p.id = ?`,
    args: [partId],
  });
  const row = rs.rows[0];
  return !!row && (includeDeleted || !row.deleted_at) && canReadSpace(Number(row.is_private ?? 0));
}

export async function authorizeFolder(folderId: number, includeDeleted = false): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT is_private, deleted_at FROM folders WHERE id = ?",
    args: [folderId],
  });
  const row = rs.rows[0];
  return !!row && (includeDeleted || !row.deleted_at) && canReadSpace(Number(row.is_private ?? 0));
}
