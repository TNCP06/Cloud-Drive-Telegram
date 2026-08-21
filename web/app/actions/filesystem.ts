"use server";

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { FsEntry, FsListing, FsShortcut } from "@/lib/types";

// NOTE: this reads the REAL filesystem of the laptop running this web server (localhost).
// Safe because it's used locally/privately. Do not expose this dashboard to the internet
// without authentication — listDir can traverse the entire disk.

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function buildShortcuts(): Promise<FsShortcut[]> {
  const home = os.homedir();
  const cands: FsShortcut[] = [
    { label: "Home", path: home },
    { label: "Desktop", path: path.join(home, "Desktop") },
    { label: "Downloads", path: path.join(home, "Downloads") },
    { label: "Documents", path: path.join(home, "Documents") },
  ];
  const od = process.env.OneDrive || process.env.OneDriveConsumer;
  if (od) cands.push({ label: "OneDrive", path: od });
  else cands.push({ label: "OneDrive", path: path.join(home, "OneDrive") });

  const out: FsShortcut[] = [];
  for (const c of cands) if (await exists(c.path)) out.push(c);

  // Available drive letters (skip floppy A/B).
  for (const L of "CDEFGHIJ".split("")) {
    const d = `${L}:\\`;
    if (await exists(d)) out.push({ label: d, path: d });
  }
  return out;
}

// System folders that frequently throw permission errors — skip them.
const SKIP = new Set(["$RECYCLE.BIN", "System Volume Information", "$WinREAgent", "Config.Msi"]);

export async function listDir(dirPath?: string): Promise<FsListing> {
  const shortcuts = await buildShortcuts();
  let cwd = dirPath && dirPath.trim() ? dirPath.trim() : os.homedir();
  cwd = path.resolve(cwd);

  let entries: FsEntry[] = [];
  let error: string | undefined;
  try {
    const dirents = await fs.readdir(cwd, { withFileTypes: true });
    const tmp: FsEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith("$") || SKIP.has(d.name)) continue;
      const full = path.join(cwd, d.name);
      let isDir = d.isDirectory();
      let size = 0;
      // Resolve symlinks/junctions (common with OneDrive) → determine dir vs file.
      if (d.isSymbolicLink()) {
        try {
          const st = await fs.stat(full);
          isDir = st.isDirectory();
          size = isDir ? 0 : st.size;
        } catch {
          continue; // unreachable target (e.g. cloud-only) — skip
        }
      } else if (!isDir) {
        try {
          size = (await fs.stat(full)).size;
        } catch {
          // locked file — leave size as 0
        }
      }
      tmp.push({ name: d.name, path: full, isDir, size });
    }
    tmp.sort((a, b) =>
      a.isDir === b.isDir
        ? a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        : a.isDir
          ? -1
          : 1
    );
    entries = tmp.slice(0, 3000); // cap entries so huge directories stay responsive
  } catch (e) {
    error = e instanceof Error ? e.message : "Cannot read this folder.";
  }

  const parentRaw = path.dirname(cwd);
  const parent = parentRaw === cwd ? null : parentRaw;
  return { cwd, parent, entries, shortcuts, error };
}
