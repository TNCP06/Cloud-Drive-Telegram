import type { DriveFile } from "./types";

// Document-type derivation. The bot only stores two coarse `kind`s (media | archive),
// so every non-media file (PDF, DOCX, XLSX, ZIP, …) lands in `archive` and would look
// identical in the UI. We recover a fine-grained type from the FIRST part's file name
// extension (falls back to the item title) purely at read time — no schema change.

// How the viewer can render this file's contents inline.
export type PreviewKind =
  | "image" // handled by the existing photo stage
  | "video" // handled by the existing Plyr stage
  | "pdf" // <iframe> via /api/stream (application/pdf)
  | "text" // fetched as text → <pre>
  | "word" // mammoth → HTML
  | "sheet" // SheetJS → HTML table(s)
  | "none"; // no inline preview (archives, unknown, multi-part) → download

export interface FileType {
  /** Stable id for the type (also used for grouping/filtering). */
  id: string;
  /** Human label, e.g. "PDF", "Word", "Spreadsheet". */
  label: string;
  /** Icon name in `icons.tsx`. */
  icon: string;
  /** Accent colour (hex). */
  tint: string;
  /** Short uppercase badge for the card (e.g. "PDF", "XLSX"); null = don't show one. */
  badge: string | null;
  /** How the viewer can preview the file inline. */
  preview: PreviewKind;
}

interface Spec {
  id: string;
  label: string;
  icon: string;
  tint: string;
  preview: PreviewKind;
  exts: string[];
}

// Order matters only for readability; lookup is by extension.
const SPECS: Spec[] = [
  {
    id: "pdf",
    label: "PDF",
    icon: "filePdf",
    tint: "#C0392B",
    preview: "pdf",
    exts: ["pdf"],
  },
  {
    id: "word",
    label: "Word",
    icon: "fileDoc",
    tint: "#2B6CB0",
    preview: "word",
    exts: ["doc", "docx", "rtf", "odt"],
  },
  {
    id: "sheet",
    label: "Spreadsheet",
    icon: "fileSheet",
    tint: "#2F855A",
    preview: "sheet",
    exts: ["xls", "xlsx", "xlsm", "ods", "csv", "tsv"],
  },
  {
    id: "slides",
    label: "Presentation",
    icon: "fileSlides",
    tint: "#C05621",
    preview: "none",
    exts: ["ppt", "pptx", "odp"],
  },
  {
    id: "archive",
    label: "Archive",
    icon: "fileZip",
    tint: "#8A8068",
    preview: "none",
    exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "001"],
  },
  {
    id: "code",
    label: "Code",
    icon: "fileCode",
    tint: "#6B5B95",
    preview: "text",
    exts: [
      "js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h", "hpp", "cs",
      "go", "rs", "rb", "php", "sh", "bash", "ps1", "sql", "html", "css",
      "scss", "yml", "yaml", "toml", "ini", "xml", "json",
    ],
  },
  {
    id: "text",
    label: "Text",
    icon: "fileText",
    tint: "#5C6E7E",
    preview: "text",
    exts: ["txt", "md", "markdown", "log"],
  },
  {
    id: "image",
    label: "Image",
    icon: "image",
    tint: "#A65656",
    preview: "image",
    exts: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "avif"],
  },
  {
    id: "video",
    label: "Video",
    icon: "video",
    tint: "#A65656",
    preview: "video",
    exts: ["mp4", "webm", "m4v", "mov", "mkv", "avi", "flv", "3gp", "ts", "wmv"],
  },
  {
    id: "subtitle",
    label: "Subtitle",
    icon: "subtitles",
    tint: "#3C7A74",
    preview: "text",
    exts: ["srt", "vtt", "ass", "ssa"],
  },
  {
    id: "audio",
    label: "Audio",
    icon: "fileText",
    tint: "#3C7A74",
    preview: "none",
    exts: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus"],
  },
];

const BY_EXT = new Map<string, Spec>();
for (const s of SPECS) for (const e of s.exts) BY_EXT.set(e, s);

const ARCHIVE_FALLBACK: FileType = {
  id: "file",
  label: "File",
  icon: "file",
  tint: "#8A8068",
  badge: null,
  preview: "none",
};

// Media WITHOUT a usable file name = a Telegram photo (always served as JPEG, no extension),
// so the fallback is an IMAGE — not a video. Named videos (.mp4/.mkv/…) match the video spec
// above and keep the video icon; only this extension-less case falls through here.
const MEDIA_FALLBACK: FileType = {
  id: "image",
  label: "Image",
  icon: "image",
  tint: "#A65656",
  badge: null,
  preview: "image",
};

/**
 * The name shown in the grid. Items carry a clean title (not a filename), so the
 * "File name extensions" toggle appends the real extension (from the first part's
 * file name) when on. Archives show their family (version stripped) as the base.
 */
export function displayName(
  item: Pick<DriveFile, "name" | "family" | "version" | "fileName" | "kind">,
  showExtensions = false
): string {
  const base = item.version ? item.family : item.name;
  if (!showExtensions) return base;
  let ext = extOf(item.fileName) || extOf(item.name);
  if (!ext && item.kind === "media") {
    // Telegram photos carry NO file name (always served as JPEG), and any media item
    // without a usable file name is treated as an image everywhere else in the app.
    // Fall back to ".jpg" so the extension shows consistently for media instead of
    // appearing only for the items that happened to be uploaded as named files.
    ext = "jpg";
  }
  if (!ext) return base;
  // Don't double up if the title already ends with the extension.
  return base.toLowerCase().endsWith("." + ext) ? base : `${base}.${ext}`;
}

/** Lowercase extension (no dot) from a file name, or "" if none. */
export function extOf(name: string | null | undefined): string {
  if (!name) return "";
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Resolve the fine-grained file type for a drive item. Uses the first part's
 * `fileName` extension; falls back to the title, then to a kind-based default.
 */
export function fileTypeFor(
  item: Pick<DriveFile, "kind" | "fileName" | "name" | "parts">
): FileType {
  const ext = extOf(item.fileName) || extOf(item.name);
  const spec = ext ? BY_EXT.get(ext) : undefined;

  if (spec) {
    // A multi-part item is split storage (e.g. a raw-split archive) — it can't be
    // previewed inline regardless of the leading extension.
    const previewable = item.parts <= 1;
    return {
      id: spec.id,
      label: spec.label,
      icon: spec.icon,
      tint: spec.tint,
      badge: ext ? ext.toUpperCase().slice(0, 4) : null,
      preview: previewable ? spec.preview : "none",
    };
  }

  // No recognised extension: keep the coarse kind's look.
  const base = item.kind === "media" ? MEDIA_FALLBACK : ARCHIVE_FALLBACK;
  return { ...base, badge: ext ? ext.toUpperCase().slice(0, 4) : null };
}
