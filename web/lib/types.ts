// Model data yang dipakai UI (hasil shaping dari Turso → mirip model desain).

export type Kind = "game" | "media";

export interface Tag {
  id: number;
  name: string;
  /** key warna pada TAG_COLORS (dipetakan deterministik dari nama). */
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
  tags: number[];          // daftar tag id
  starred: boolean;        // is_favorite
  trashed: boolean;        // deleted_at != NULL
  deletedAt: number | null;
  thumb: string | null;    // data URL (hanya media yang punya)
  family: string;          // nama dasar (judul tanpa versi) untuk grouping
  familyKey: string;       // kunci grouping (lowercase)
  version: string | null;  // label versi, mis. "v0.6.0" (game saja)
}

export type UploadStatus = "queued" | "pending" | "running" | "done" | "error" | "canceled";

export interface UploadJob {
  id: number;
  kind: Kind;
  title: string;
  tags: string;
  sourcePath: string;   // path file/folder DI LAPTOP
  partSize: number;     // MB (khusus game)
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

// --- Penjelajah file laptop (server membaca disk asli via Node fs) ---
export interface FsEntry {
  name: string;
  path: string;   // path absolut asli di laptop
  isDir: boolean;
  size: number;   // bytes (0 untuk folder)
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
