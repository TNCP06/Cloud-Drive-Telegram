// Pure view-model logic for the drive screen: section grouping, sort comparators, and the
// optimistic-overlay reducers. Kept out of DriveApp.tsx (the stateful container) so that
// component stays focused on wiring/state and these side-effect-free pieces stay unit-testable.
import { relGroup } from "@/lib/format";
import { fileTypeFor } from "@/lib/fileType";
import type { DriveFile, Tag, Folder } from "@/lib/types";

/* ---- Group by (Windows-Explorer-style section grouping) ----
   Splits the visible files into labelled sections. Items keep the active sort order
   within each section; grouping is suppressed while searching. */
export type GroupKey = "none" | "name" | "type" | "tag" | "modified" | "size";
export const GROUP_OPTIONS: { key: GroupKey; label: string }[] = [
  { key: "none", label: "(None)" },
  { key: "name", label: "Name" },
  { key: "type", label: "Type" },
  { key: "tag", label: "Tag" },
  { key: "modified", label: "Date modified" },
  { key: "size", label: "Size" },
];

const SIZE_BUCKET_ORDER = [
  "Tiny (< 1 MB)",
  "Small (1–10 MB)",
  "Medium (10–100 MB)",
  "Large (100 MB – 1 GB)",
  "Huge (> 1 GB)",
  "Unknown",
];
function sizeBucket(bytes: number): string {
  if (!bytes) return "Unknown";
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  if (bytes < MB) return "Tiny (< 1 MB)";
  if (bytes < 10 * MB) return "Small (1–10 MB)";
  if (bytes < 100 * MB) return "Medium (10–100 MB)";
  if (bytes < GB) return "Large (100 MB – 1 GB)";
  return "Huge (> 1 GB)";
}

// Build ordered { label, items } sections for a (pre-sorted) list. Items stay in the
// incoming order within each section. Returns null for "none".
export function buildGroups(
  list: DriveFile[],
  key: GroupKey,
  tags: Tag[]
): { label: string; items: DriveFile[] }[] | null {
  if (key === "none") return null;
  const groups = new Map<string, DriveFile[]>();
  const push = (label: string, f: DriveFile) => {
    const arr = groups.get(label);
    if (arr) arr.push(f);
    else groups.set(label, [f]);
  };

  if (key === "modified") {
    list.forEach((f) => push(relGroup(f.modified), f));
    const order = ["Today", "Yesterday", "This week", "This month", "Older"];
    return order.filter((g) => groups.has(g)).map((g) => ({ label: g, items: groups.get(g)! }));
  }
  if (key === "size") {
    list.forEach((f) => push(sizeBucket(f.size), f));
    return SIZE_BUCKET_ORDER.filter((g) => groups.has(g)).map((g) => ({ label: g, items: groups.get(g)! }));
  }
  if (key === "name") {
    list.forEach((f) => {
      const c = (f.name.trim()[0] || "#").toUpperCase();
      push(/[A-Z]/.test(c) ? c : "#", f);
    });
  } else if (key === "type") {
    list.forEach((f) => push(fileTypeFor(f).label, f));
  } else {
    // tag → first tag (or "Untagged"); a file lands in exactly one section to avoid dupes.
    const nameOf = new Map(tags.map((t) => [t.id, t.name]));
    list.forEach((f) => push(f.tags.length ? nameOf.get(f.tags[0]) ?? "Untagged" : "Untagged", f));
  }
  // Alphabetical, with the catch-all bucket ("#" / "Untagged") pinned last.
  const catchAll = key === "tag" ? "Untagged" : "#";
  const labels = [...groups.keys()].sort((a, b) =>
    a === catchAll ? 1 : b === catchAll ? -1 : a.localeCompare(b, "en")
  );
  return labels.map((l) => ({ label: l, items: groups.get(l)! }));
}

export const SORTS: Record<string, { label: string; fn: (a: DriveFile, b: DriveFile, order: "asc" | "desc") => number }> = {
  modified: {
    label: "Last modified",
    fn: (a, b, order) => (order === "asc" ? a.modified - b.modified : b.modified - a.modified),
  },
  added: {
    label: "Date added",
    fn: (a, b, order) => (order === "asc" ? a.added - b.added : b.added - a.added),
  },
  name: {
    label: "Name",
    fn: (a, b, order) => (order === "asc" ? a.name.localeCompare(b.name, "en") : b.name.localeCompare(a.name, "en")),
  },
  size: {
    label: "Size",
    fn: (a, b, order) => {
      const szA = a.size || 0;
      const szB = b.size || 0;
      return order === "asc" ? szA - szB : szB - szA;
    },
  },
  kind: {
    label: "Type",
    fn: (a, b, order) => (order === "asc" ? a.kind.localeCompare(b.kind) : b.kind.localeCompare(a.kind)),
  },
};

// ---- Optimistic UI reducers ----
// Mutations update these overlays instantly; the server action then revalidates and the
// real props replace the overlay (a failed action just drops the overlay → auto-rollback).
export type FileAction =
  | { type: "star"; ids: number[]; starred: boolean }
  | { type: "trash"; ids: number[] }
  | { type: "restore"; ids: number[] }
  | { type: "remove"; ids: number[] }
  | { type: "meta"; id: number; title: string; kind: DriveFile["kind"] }
  | { type: "move"; ids: number[]; folderId: number | null };

export function fileReducer(state: DriveFile[], a: FileAction): DriveFile[] {
  switch (a.type) {
    case "star":
      return state.map((f) => (a.ids.includes(f.id) ? { ...f, starred: a.starred } : f));
    case "trash":
      return state.map((f) => (a.ids.includes(f.id) ? { ...f, trashed: true, deletedAt: Date.now() } : f));
    case "restore":
      return state.map((f) => (a.ids.includes(f.id) ? { ...f, trashed: false, deletedAt: null } : f));
    case "remove":
      return state.filter((f) => !a.ids.includes(f.id));
    case "meta":
      return state.map((f) => (f.id === a.id ? { ...f, name: a.title, family: a.title, kind: a.kind } : f));
    case "move":
      return state.map((f) => (a.ids.includes(f.id) ? { ...f, folderId: a.folderId } : f));
    default:
      return state;
  }
}

export type FolderAction =
  | { type: "create"; folder: Folder }
  | { type: "rename"; id: number; name: string }
  | { type: "delete"; ids: number[] }
  | { type: "move"; id: number; parentId: number | null };

export function folderReducer(state: Folder[], a: FolderAction): Folder[] {
  switch (a.type) {
    case "create":
      return [...state, a.folder];
    case "rename":
      return state.map((f) => (f.id === a.id ? { ...f, name: a.name } : f));
    case "delete":
      return state.filter((f) => !a.ids.includes(f.id));
    case "move":
      return state.map((f) => (f.id === a.id ? { ...f, parentId: a.parentId } : f));
    default:
      return state;
  }
}
