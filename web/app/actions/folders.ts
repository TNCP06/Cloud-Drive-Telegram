"use server";

import { db } from "@/lib/db";
import { refresh } from "./_shared";
import { authorizeFolder } from "@/lib/resourceAuth";

// --- Folder management --------------------------------------------------------

export async function createFolder(name: string, parentId: number | null, isPrivate = false) {
  const n = name.trim();
  if (!n) throw new Error("Folder name cannot be empty.");

  let priv = isPrivate ? 1 : 0;
  if (!isPrivate && parentId !== null) {
    const parentRs = await db.execute({
      sql: "SELECT is_private FROM folders WHERE id = ?",
      args: [parentId],
    });
    if (parentRs.rows.length && Number(parentRs.rows[0].is_private) === 1) {
      priv = 1;
    }
  }

  await db.execute({
    sql: "INSERT INTO folders (name, parent_id, is_private) VALUES (?, ?, ?)",
    args: [n, parentId, priv],
  });
  refresh();
}

export async function renameFolder(id: number, name: string) {
  if (!(await authorizeFolder(id))) throw new Error("Folder not found.");
  const n = name.trim();
  if (!n) throw new Error("Folder name cannot be empty.");

  await db.execute({
    sql: "UPDATE folders SET name = ?, updated_at = now_text() WHERE id = ?",
    args: [n, id],
  });
  refresh();
}

// Get all item + subfolder IDs inside a folder recursively.
export async function getFolderItemsAndSubfolders(
  folderId: number
): Promise<{ itemIds: number[]; folderIds: number[] }> {
  const fRs = await db.execute({
    sql: `
      WITH RECURSIVE subfolders AS (
        SELECT id FROM folders WHERE id = ?
        UNION ALL
        SELECT f.id FROM folders f
        JOIN subfolders s ON f.parent_id = s.id
      )
      SELECT id FROM subfolders
    `,
    args: [folderId],
  });
  const folderIds = fRs.rows.map((r) => Number(r.id));
  if (folderIds.length === 0) return { itemIds: [], folderIds: [folderId] };

  const iRs = await db.execute({
    sql: "SELECT id FROM items WHERE folder_id = ANY(?)",
    args: [folderIds],
  });
  const itemIds = iRs.rows.map((r) => Number(r.id));
  return { itemIds, folderIds };
}

export async function deleteFolder(id: number) {
  if (!(await authorizeFolder(id))) throw new Error("Folder not found.");
  const { itemIds, folderIds } = await getFolderItemsAndSubfolders(id);

  if (itemIds.length > 0) {
    await db.execute({
      sql: "UPDATE items SET deleted_at = now_text() WHERE id = ANY(?) AND deleted_at IS NULL",
      args: [itemIds],
    });
  }

  if (folderIds.length > 0) {
    await db.execute({
      sql: "UPDATE folders SET deleted_at = now_text() WHERE id = ANY(?) AND deleted_at IS NULL",
      args: [folderIds],
    });
  }

  refresh();
}

export async function restoreParentChain(folderId: number | null) {
  if (folderId === null) return;
  await restoreParentChains([folderId]);
}

export async function restoreParentChains(folderIds: number[]) {
  if (folderIds.length === 0) return;
  await db.execute({
    sql: `WITH RECURSIVE ancestors AS (
            SELECT id, parent_id FROM folders WHERE id = ANY(?)
            UNION ALL
            SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id
          )
          UPDATE folders SET deleted_at = NULL
          WHERE id IN (SELECT id FROM ancestors)`,
    args: [folderIds],
  });
}

export async function restoreFolder(id: number) {
  if (!(await authorizeFolder(id, true))) throw new Error("Folder not found.");
  await restoreParentChain(id);
  const { itemIds, folderIds } = await getFolderItemsAndSubfolders(id);

  if (itemIds.length > 0) {
    await db.execute({
      sql: "UPDATE items SET deleted_at = NULL WHERE id = ANY(?)",
      args: [itemIds],
    });
  }

  if (folderIds.length > 0) {
    await db.execute({
      sql: "UPDATE folders SET deleted_at = NULL WHERE id = ANY(?)",
      args: [folderIds],
    });
  }

  refresh();
}

import { bulkPurgeNow } from "./items";

export async function purgeFolderNow(id: number): Promise<{ ok: boolean; error?: string }> {
  if (!(await authorizeFolder(id, true))) return { ok: false, error: "Folder not found." };
  const { itemIds } = await getFolderItemsAndSubfolders(id);

  if (itemIds.length > 0) {
    const res = await bulkPurgeNow(itemIds);
    if (!res.ok) return res;
  }

  await db.execute({
    sql: "DELETE FROM folders WHERE id = ?",
    args: [id],
  });

  refresh();
  return { ok: true };
}

export async function moveItemsToFolder(itemIds: number[], folderId: number | null) {
  if (itemIds.length === 0) return;
  // An item takes the space of the folder it moves into: a Main item dropped into a Private
  // folder would otherwise be invisible in both views (wrong space in Private, folder absent
  // in Main) and only reachable through Recent.
  let isPrivate: number | null = null;
  if (folderId !== null) {
    const rs = await db.execute({
      sql: "SELECT is_private FROM folders WHERE id = ?",
      args: [folderId],
    });
    if (rs.rows.length) isPrivate = Number(rs.rows[0].is_private ?? 0);
  }
  if (isPrivate === null) {
    await db.execute({
      sql: "UPDATE items SET folder_id = ?, updated_at = now_text() WHERE id = ANY(?)",
      args: [folderId, itemIds],
    });
  } else {
    await db.execute({
      sql: "UPDATE items SET folder_id = ?, is_private = ?, updated_at = now_text() WHERE id = ANY(?)",
      args: [folderId, isPrivate, itemIds],
    });
  }
  refresh();
}

// Reparent a folder into another folder (or the root). Rejects moving a folder into
// itself or one of its own descendants, which would create a cycle.
export async function moveFolderToFolder(folderId: number, targetParentId: number | null) {
  if (!(await authorizeFolder(folderId))) throw new Error("Folder not found.");
  if (targetParentId !== null && !(await authorizeFolder(targetParentId))) {
    throw new Error("Target folder not found.");
  }
  if (targetParentId === folderId) throw new Error("Cannot move a folder into itself.");
  if (targetParentId !== null) {
    const { folderIds } = await getFolderItemsAndSubfolders(folderId);
    if (folderIds.includes(targetParentId)) {
      throw new Error("Cannot move a folder into one of its own subfolders.");
    }
    const spaces = await db.execute({
      sql: `SELECT f.is_private AS source_private, p.is_private AS target_private
            FROM folders f JOIN folders p ON p.id = ? WHERE f.id = ?`,
      args: [targetParentId, folderId],
    });
    if (spaces.rows.length && Number(spaces.rows[0].source_private) !== Number(spaces.rows[0].target_private)) {
      throw new Error("Cannot move a folder across Main and Private spaces.");
    }
  }
  await db.execute({
    sql: "UPDATE folders SET parent_id = ?, updated_at = now_text() WHERE id = ?",
    args: [targetParentId, folderId],
  });
  refresh();
}
