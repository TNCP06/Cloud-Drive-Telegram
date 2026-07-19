import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createReadStream, statSync } from "fs";
import path from "path";
import { Readable } from "stream";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";
import { db } from "@/lib/db";

// Download a kept unpack output (> 2 GB file stored on the VPS instead of Telegram).
// Streams straight off the shared staging volume; supports a single Range so a
// multi-GB download can resume. Auth checked manually — same pattern as /api/stream.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEEP_ROOT = path.join(process.env.UPLOAD_STAGING_DIR || "/staging", "_unpack", "_keep");

async function checkAuth(): Promise<boolean> {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true; // no password set → auth disabled
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return !!token && token === (await sha256Hex(pw));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await checkAuth())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id } = await params;
  const rs = await db.execute({
    sql: "SELECT rel_path, file_name FROM unpack_kept WHERE id = ?",
    args: [Number(id)],
  });
  if (!rs.rows.length) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const full = path.resolve(KEEP_ROOT, String(rs.rows[0].rel_path));
  if (!full.startsWith(path.resolve(KEEP_ROOT) + path.sep)) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  let st;
  try {
    st = statSync(full);
  } catch {
    return NextResponse.json(
      { error: "File is gone from the server (expired or deleted)." },
      { status: 404 }
    );
  }

  const fileName = String(rs.rows[0].file_name || "download.bin");
  // Playable types get their real mime + inline disposition, so opening the URL in a tab streams
  // it in the browser's native player (Range support above gives seeking). The modal's Download
  // button uses the <a download> attribute, which forces a download regardless of disposition.
  const MIME: Record<string, string> = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
    ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
    ".flac": "audio/flac", ".wav": "audio/wav", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  };
  const ext = path.extname(fileName).toLowerCase();
  const mime = MIME[ext];
  const headers = new Headers({
    "content-type": mime || "application/octet-stream",
    "accept-ranges": "bytes",
    "content-disposition":
      `${mime ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (m) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), end);
    if (start > end) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${st.size}` },
      });
    }
    status = 206;
    headers.set("content-range", `bytes ${start}-${end}/${st.size}`);
  }
  headers.set("content-length", String(end - start + 1));

  const stream = Readable.toWeb(createReadStream(full, { start, end })) as ReadableStream;
  return new Response(stream, { status, headers });
}
