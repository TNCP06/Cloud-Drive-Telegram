// Data model used by the UI (shaped from Turso → mirrors the design model).

export type Kind = "archive" | "media";

export interface GalleryPart {
  partId: number;
  fileName: string | null;
  thumb: string | null;
  /** Part's own file size in bytes (for the filmstrip hover tooltip). */
  size: number;
}

export interface Tag {
  id: number;
  name: string;
  /** Color key in TAG_COLORS (deterministically mapped from name). */
  color: string;
}

export interface Folder {
  id: number;
  name: string;
  parentId: number | null;
  createdAt: number;
  updatedAt: number;
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
  firstPartId: number | null;  // parts.id of the first part (for streaming URL)
  fileName: string | null;     // parts.file_name (for video vs image detection)
  family: string;          // base name (title without version) for grouping
  familyKey: string;       // grouping key (lowercase)
  version: string | null;  // version label, e.g. "v0.6.0" (archives only)
  folderId: number | null; // items.folder_id
}

export type UploadStatus = "queued" | "pending" | "running" | "done" | "error" | "canceled";

export type UploadOrigin = "local" | "upload";

export interface UploadJob {
  id: number;
  kind: Kind;
  title: string;
  tags: string;
  sourcePath: string;   // laptop path (local) or staging dir (upload)
  partSize: number;     // MB (archives only)
  origin: UploadOrigin; // 'local' = laptop path, 'upload' = staged browser upload
  partsDone: number;    // checkpoint: parts already pushed to Telegram (resume point)
  totalBytes: number;   // file size in bytes (staged uploads)
  status: UploadStatus;
  progress: number;     // 0..100
  message: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BotStatus {
  online: boolean;
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
