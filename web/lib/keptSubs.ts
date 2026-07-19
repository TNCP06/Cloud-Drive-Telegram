import { cookies } from "next/headers";
import { readdir } from "fs/promises";
import path from "path";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";
import { db } from "@/lib/db";

// Subtitle support for kept-on-server files (unpack outputs over the Telegram cap). The streamer's
// part-keyed subtitle system can't help here — it never mounts the staging volume the kept files
// live on. So subtitles ride as sibling WebVTT files next to the kept file on the shared /staging
// volume the web container mounts: `<kept-file>.<lang>.vtt`. Cleaned up with the kept file itself.

export const KEEP_ROOT = path.join(
  process.env.UPLOAD_STAGING_DIR || "/staging",
  "_unpack",
  "_keep"
);

export async function keptAuthOk(): Promise<boolean> {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true; // no password set → auth disabled
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return !!token && token === (await sha256Hex(pw));
}

// Resolve a kept file's absolute path from its id, rejecting any path escaping KEEP_ROOT.
export async function resolveKeptFile(
  id: number
): Promise<{ full: string; fileName: string } | null> {
  const rs = await db.execute({
    sql: "SELECT rel_path, file_name FROM unpack_kept WHERE id = ?",
    args: [id],
  });
  if (!rs.rows.length) return null;
  const full = path.resolve(KEEP_ROOT, String(rs.rows[0].rel_path));
  if (!full.startsWith(path.resolve(KEEP_ROOT) + path.sep)) return null;
  return { full, fileName: String(rs.rows[0].file_name || "video") };
}

export const subSiblingPath = (full: string, lang: string) => `${full}.${lang}.vtt`;

// Languages that have a sibling VTT on disk for this kept file.
export async function listKeptSubLangs(full: string): Promise<string[]> {
  const dir = path.dirname(full);
  const prefix = path.basename(full) + ".";
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const langs: string[] = [];
  for (const n of names) {
    if (n.startsWith(prefix) && n.endsWith(".vtt")) {
      const lang = n.slice(prefix.length, -4);
      if (/^[a-z]{2,8}$/.test(lang)) langs.push(lang);
    }
  }
  return langs.sort();
}

// Convert an uploaded subtitle to WebVTT text. The web (Node) image has no ffmpeg and the streamer
// can't see the file, so we handle the two browser-relevant text formats in-process: SRT (the
// common case — normalise the comma-decimal timestamps and prepend the header) and VTT (validate
// + ensure the header). ASS/SSA styling can't render in an HTML <track> anyway, so they're rejected
// upstream. ponytail: pure SRT/VTT only; add ffmpeg-backed formats if a real need shows up.
export function toVtt(text: string, ext: string): string {
  const body = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").trim();
  if (ext === "vtt") {
    if (!body.includes("-->")) throw new Error("No cues found in the subtitle file.");
    return body.startsWith("WEBVTT") ? body + "\n" : `WEBVTT\n\n${body}\n`;
  }
  // SRT → VTT: swap comma-decimal timestamps to dots; the header does the rest.
  const converted = body.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    "$1.$2"
  );
  if (!converted.includes("-->")) throw new Error("No cues found in the subtitle file.");
  return `WEBVTT\n\n${converted}\n`;
}
