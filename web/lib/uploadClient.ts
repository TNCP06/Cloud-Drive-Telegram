import type { Kind } from "@/lib/types";

// Client-side resumable upload engine (no server imports — safe in client components).
// Sends one file to /api/upload in chunks, resuming from the server offset on a drop,
// then calls /api/upload/complete to queue a watcher job. Returns the new job id so the
// caller can immediately start it (one click → full browser→VPS→Telegram pipeline).

const CHUNK = 16 * 1024 * 1024; // 16 MB per request
const MAX_RETRY = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Telegram (via the local Bot API) caps one file at ~2 GB. Anything larger MUST be split
// to upload at all, so the auto picker routes big files to the splitting pipeline
// (kind="archive", stream-split by the watcher) with the default part size; everything
// ≤ 2 GB uploads as a single media file (keeps inline preview/thumbnail support).
export const SPLIT_THRESHOLD_BYTES = 2000 * 1024 * 1024; // ~2 GB
export const DEFAULT_PART_MB = 1500;

// Auto-pick the upload kind for a file when no explicit kind is chosen: split big files,
// keep everything else as a single media file.
export function autoKindFor(size: number): Kind {
  return size > SPLIT_THRESHOLD_BYTES ? "archive" : "media";
}

export interface UploadCtl {
  readonly cancel: boolean;
  readonly pause: boolean;
  setAbort: (a: AbortController | null) => void;
}

export interface UploadOpts {
  kind: Kind;
  title: string;
  tags: string;
  partSize: number;
}

export type UploadResult =
  | { status: "done"; jobId?: number }
  | { status: "error"; error: string }
  | { status: "paused" }
  | { status: "canceled" };

export function newToken(): string {
  return (crypto.randomUUID?.() ?? String(Date.now()) + Math.random()).replace(/[-.]/g, "");
}

export async function uploadResumable(
  file: Blob,
  name: string,
  token: string,
  opts: UploadOpts,
  onProgress: (sent: number, speed: number) => void,
  ctl: UploadCtl
): Promise<UploadResult> {
  let offset = 0;
  try {
    const r = await fetch(`/api/upload?token=${token}&name=${encodeURIComponent(name)}`);
    if (r.ok) offset = (await r.json()).received ?? 0;
  } catch {
    /* start from 0 */
  }
  if (offset > file.size) offset = 0;
  onProgress(offset, 0);

  let anchor = { t: Date.now(), bytes: offset };

  while (offset < file.size) {
    if (ctl.cancel) return { status: "canceled" };
    if (ctl.pause) return { status: "paused" };

    const end = Math.min(offset + CHUNK, file.size);
    const blob = file.slice(offset, end);
    const ac = new AbortController();
    ctl.setAbort(ac);

    let ok = false;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      if (ctl.cancel) return { status: "canceled" };
      if (ctl.pause) return { status: "paused" };
      try {
        const res = await fetch(
          `/api/upload?token=${token}&name=${encodeURIComponent(name)}&offset=${offset}`,
          { method: "POST", body: blob, signal: ac.signal }
        );
        if (res.status === 409) {
          const j = await res.json();
          offset = Number(j.received ?? offset);
          onProgress(offset, 0);
          ok = true;
          break;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        offset = Number(j.received ?? end);
        const now = Date.now();
        let sp = 0;
        if (now - anchor.t > 1200) {
          sp = ((offset - anchor.bytes) * 1000) / (now - anchor.t);
          anchor = { t: now, bytes: offset };
        }
        onProgress(offset, sp);
        ok = true;
        break;
      } catch {
        if (ctl.cancel) return { status: "canceled" };
        if (ctl.pause) return { status: "paused" };
        if (attempt === MAX_RETRY)
          return { status: "error", error: "Connection lost — progress saved, retry to continue." };
        await sleep(Math.min(1000 * 2 ** attempt, 15000));
      }
    }
    if (!ok) return { status: "error", error: "Upload interrupted." };
  }

  // Whole file staged → queue the watcher job.
  try {
    const res = await fetch("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        name,
        size: file.size,
        kind: opts.kind,
        title: opts.title,
        tags: opts.tags,
        partSize: opts.partSize,
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "Failed to queue upload.");
    return { status: "done", jobId: typeof j.jobId === "number" ? j.jobId : undefined };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "Failed to queue upload." };
  }
}

// Auto-tag by file type: image → "Image", video → "Video", archive kind → "Archive".
const IMAGE_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif", ".avif", ".tif", ".tiff", ".svg",
]);
const VIDEO_EXT = new Set([
  ".mp4", ".webm", ".m4v", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".ts", ".3gp", ".mpg", ".mpeg",
]);

export function autoTypeTag(fileName: string, kind: Kind): string | null {
  if (kind === "archive") return "Archive";
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  if (IMAGE_EXT.has(ext)) return "Image";
  if (VIDEO_EXT.has(ext)) return "Video";
  return null;
}

// Merge a tag into a comma-separated tag string (case-insensitive dedupe).
export function withTag(tags: string, tag: string | null): string {
  if (!tag) return tags;
  const list = tags.split(",").map((t) => t.trim()).filter(Boolean);
  if (list.some((t) => t.toLowerCase() === tag.toLowerCase())) return tags;
  return [...list, tag].join(", ");
}
