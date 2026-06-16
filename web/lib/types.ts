// Data model used by the UI (shaped from Turso → mirrors the design model).

export type Kind = "game" | "media";

export interface Tag {
  id: number;
  name: string;
  /** Color key in TAG_COLORS (deterministically mapped from name). */
  color: string;
}

export interface DriveFile {
  id: number;
  slug: string;
  name: string;            // items.title
  kind: Kind;              // items.kind
  size: number;            // items.total_size (bytes)
  parts: number;           // items.total_parts
  modified: number;        // updated_at → epoch ms
  added: number;           // date_added → epoch ms
  tags: number[];          // list of tag ids
  starred: boolean;        // is_favorite
  trashed: boolean;        // deleted_at != NULL
  deletedAt: number | null;
  thumb: string | null;    // data URL (only media items have this)
  family: string;          // base name (title without version) for grouping
  familyKey: string;       // grouping key (lowercase)
  version: string | null;  // version label, e.g. "v0.6.0" (games only)
}

export type UploadStatus = "queued" | "pending" | "running" | "done" | "error" | "canceled";

export interface UploadJob {
  id: number;
  kind: Kind;
  title: string;
  tags: string;
  sourcePath: string;   // file/folder path on the laptop
  partSize: number;     // MB (games only)
  status: UploadStatus;
  progress: number;     // 0..100
  message: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WatcherStatus {
  online: boolean;
  status: "idle" | "busy" | null;
  lastSeen: number | null;
}

// --- Laptop file browser (server reads the real disk via Node fs) ---
export interface FsEntry {
  name: string;
  path: string;   // absolute path on the laptop
  isDir: boolean;
  size: number;   // bytes (0 for directories)
}
export interface FsShortcut {
  label: string;
  path: string;
}
export interface FsListing {
  cwd: string;
  parent: string | null;
  entries: FsEntry[];
  shortcuts: FsShortcut[];
  error?: string;
}
