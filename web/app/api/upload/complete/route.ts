import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { stat } from "node:fs/promises";
import { db } from "@/lib/db";
import { jobDir, stagedFilePath } from "@/lib/staging";
import type { Kind } from "@/lib/types";

// Finalize a resumable upload: verify the staged file is fully received, then queue
// an upload_job for the watcher (origin='upload', cleanup_source=1 → the watcher
// deletes the staged file once it has been pushed to Telegram).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: {
    token?: string;
    name?: string;
    size?: number;
    kind?: Kind;
    title?: string;
    tags?: string;
    partSize?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const token = String(body.token ?? "");
  const name = String(body.name ?? "");
  const kind: Kind = body.kind === "media" ? "media" : "archive";
  const size = Number(body.size ?? 0);
  const partSize = Number(body.partSize ?? 1500) || 1500;

  let file: string;
  let dir: string;
  try {
    file = stagedFilePath(token, name);
    dir = jobDir(token);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // The file must exist and be exactly the size the client claims — otherwise the
  // upload is incomplete (don't queue a truncated/corrupt file).
  let onDisk: number;
  try {
    onDisk = (await stat(file)).size;
  } catch {
    return NextResponse.json({ error: "Staged file not found." }, { status: 404 });
  }
  if (size > 0 && onDisk !== size) {
    return NextResponse.json(
      { error: `Incomplete upload (${onDisk}/${size} bytes).`, received: onDisk },
      { status: 409 }
    );
  }

  // Title: archives require one (grouping key); media derives from the filename.
  let title = String(body.title ?? "").trim();
  if (!title) {
    if (kind === "media") {
      title = name.replace(/\.[^.]+$/, "").trim() || "media";
    } else {
      return NextResponse.json({ error: "Title is required for archives." }, { status: 400 });
    }
  }
  const tags = String(body.tags ?? "").trim();

  const rs = await db.execute({
    sql:
      "INSERT INTO upload_jobs (kind, title, tags, source_path, part_size, origin, cleanup_source, total_bytes, status) " +
      "VALUES (?, ?, ?, ?, ?, 'upload', 1, ?, 'queued')",
    args: [kind, title, tags, dir, partSize, onDisk],
  });

  return NextResponse.json({ ok: true, jobId: Number(rs.lastInsertRowid ?? 0) });
}
