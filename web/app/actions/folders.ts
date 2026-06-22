"use server";

import { db } from "@/lib/db";
import { refresh } from "./_shared";

// --- Folder management --------------------------------------------------------

export async function createFolder(name: string, parentId: number | null) {
  const n = name.trim();
  if (!n) throw new Error("Folder name cannot be empty.");

  await db.execute({
    sql: "INSERT INTO folders (name, parent_id) VALUES (?, ?)",
    args: [n, parentId],
  });
  refresh();
}

export async function renameFolder(id: number, name: string) {
  const n = name.trim();
  if (!n) throw new Error("Folder name cannot be empty.");

  await db.execute({
    sql: "UPDATE folders SET name = ?, updated_at = now_text() WHERE id = ?",
    args: [n, id],
  });
  refresh();
}

// Get all item + subfolder IDs inside a folder recursively.
async function getFolderItemsAndSubfolders(
  folderId: number
): Promise<{ itemIds: number[]; folderIds: number[] }> {
  const itemIds: number[] = [];
  const folderIds: number[] = [folderId];

  const itemsRs = await db.execute({
    sql: "SELECT id FROM items WHERE folder_id = ?",
    args: [folderId],
  });
  for (const row of itemsRs.rows) {
    itemIds.push(Number(row.id));
  }

  const subRs = await db.execute({
    sql: "SELECT id FROM folders WHERE parent_id = ?",
    args: [folderId],
  });
  for (const row of subRs.rows) {
    const subFolderId = Number(row.id);
    const recurse = await getFolderItemsAndSubfolders(subFolderId);
    itemIds.push(...recurse.itemIds);
    folderIds.push(...recurse.folderIds);
  }

  return { itemIds, folderIds };
}

export async function deleteFolder(id: number) {
  const { itemIds } = await getFolderItemsAndSubfolders(id);

  if (itemIds.length > 0) {
    // Soft delete items inside recursively.
    for (const itemId of itemIds) {
      await db.execute({
        sql: "UPDATE items SET deleted_at = now_text() WHERE id = ? AND deleted_at IS NULL",
        args: [itemId],
      });
    }
  }

  // Hard delete the folder. parent_id references folders(id) ON DELETE CASCADE, so
  // deleting the top folder automatically cascade-deletes all child folders.
  await db.execute({
    sql: "DELETE FROM folders WHERE id = ?",
    args: [id],
  });

  refresh();
}

export async function moveItemsToFolder(itemIds: number[], folderId: number | null) {
  if (itemIds.length === 0) return;
  for (const itemId of itemIds) {
    await db.execute({
      sql: "UPDATE items SET folder_id = ?, updated_at = now_text() WHERE id = ?",
      args: [folderId, itemId],
    });
  }
  refresh();
}

// Reparent a folder into another folder (or the root). Rejects moving a folder into
// itself or one of its own descendants, which would create a cycle.
export async function moveFolderToFolder(folderId: number, targetParentId: number | null) {
  if (targetParentId === folderId) throw new Error("Cannot move a folder into itself.");
  if (targetParentId !== null) {
    const { folderIds } = await getFolderItemsAndSubfolders(folderId);
    if (folderIds.includes(targetParentId)) {
      throw new Error("Cannot move a folder into one of its own subfolders.");
    }
  }
  await db.execute({
    sql: "UPDATE folders SET parent_id = ?, updated_at = now_text() WHERE id = ?",
    args: [targetParentId, folderId],
  });
  refresh();
}
