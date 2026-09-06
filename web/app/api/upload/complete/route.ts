import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { stat } from "node:fs/promises";
import { db } from "@/lib/db";
import { jobDir, stagedFilePath } from "@/lib/staging";
import { STAGING_HEADROOM_BYTES, stagingStat } from "@/lib/stagingHealth";
import { SPLIT_THRESHOLD_BYTES, VIDEO_EXTS } from "@/lib/uploadClient";
import type { Kind } from "@/lib/types";
import { isAppAuthenticated } from "@/lib/apiAuth";
import { isPrivateUnlocked } from "@/app/actions/private";

// Same routing the watcher uses (plan_media): an oversized file with a video
// extension is re-segmented, which needs ~a second copy of the file on disk.
function isVideoName(n: string): boolean {
  const dot = n.lastIndexOf(".");
  const ext = dot >= 0 ? n.slice(dot).toLowerCase() : "";
  return (VIDEO_EXTS as readonly string[]).includes(ext);
}

// Finalize a resumable upload: verify the staged file is fully received, then queue
// an upload_job for the watcher (origin='upload', cleanup_source=1 → the watcher
// deletes the staged file once it has been pushed to Telegram).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!(await isAppAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  let body: {
    token?: string;
    name?: string;
    size?: number;
    kind?: Kind;
    title?: string;
    tags?: string;
    partSize?: number;
    isPrivate?: boolean;
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
  // upload is incomplete (don't queue a truncated/corrupt file). The client
  // always declares its size, so a missing/zero size is a protocol error, not
  // an empty file (empty files declare size 0 AND land 0 bytes — still equal).
  let onDisk: number;
  try {
    onDisk = (await stat(file)).size;
  } catch {
    return NextResponse.json({ error: "Staged file not found." }, { status: 404 });
  }
  if (!Number.isFinite(size) || onDisk !== size) {
    return NextResponse.json(
      { error: `Incomplete upload (${onDisk}/${Number.isFinite(size) ? size : "?"} bytes).`, received: onDisk },
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

  // Idempotency: the staging dir is unique per token, so if a job already exists for
  // it (e.g. the client retried complete after a reload), return that job instead of
  // inserting a duplicate.
  const existing = await db.execute({
    sql: "SELECT id FROM upload_jobs WHERE source_path = ? LIMIT 1",
    args: [dir],
  });
  if (existing.rows.length > 0) {
    return NextResponse.json({ ok: true, jobId: Number(existing.rows[0].id) });
  }

  const isPrivate = body.isPrivate ? 1 : 0;
  if (isPrivate && !(await isPrivateUnlocked())) {
    return NextResponse.json({ error: "Private space is locked." }, { status: 403 });
  }

  // Disk guard: the watcher needs headroom on the shared staging volume while
  // this job runs — one part window for stream-split files, or ~a full second
  // copy for an oversized video the watcher must re-segment into playable
  // parts (split_video refuses below size × 1.05). Refuse early with a message
  // that distinguishes "never fits this VPS" from "temporarily full".
  // The staged bytes are kept so the client can retry later once space frees up.
  const st = stagingStat();
  const bigVideo =
    kind === "media" && onDisk > SPLIT_THRESHOLD_BYTES && isVideoName(name);
  const need = bigVideo
    ? Math.ceil(onDisk * 1.1) + STAGING_HEADROOM_BYTES
    : partSize * 1024 * 1024 + STAGING_HEADROOM_BYTES;
  if (st !== null && st.free < need) {
    const freeMb = Math.floor(st.free / 1048576);
    const needMb = Math.floor(need / 1048576);
    const neverFits = need > st.total;
    return NextResponse.json(
      {
        error: neverFits
          ? `This file can never fit this VPS (needs ~${needMb} MB headroom, volume is ${Math.floor(st.total / 1048576)} MB total). ` +
            `Split it on your device first, or free VPS disk. Your staged file is kept.`
          : bigVideo
            ? `Not enough VPS space to cut this large video (free ${freeMb} MB, need ~${needMb} MB while segmenting). ` +
              `Wait for queued uploads to finish, then retry. Your staged file is kept.`
            : `Not enough VPS staging space (free ${freeMb} MB, need ~${needMb} MB headroom for the Telegram upload). ` +
              `Wait for queued uploads to finish, then retry. Your staged file is kept.`,
        retryable: !neverFits,
      },
      { status: 507 }
    );
  }

  const rs = await db.execute({
    sql:
      "INSERT INTO upload_jobs (kind, title, tags, source_path, part_size, origin, cleanup_source, total_bytes, status, is_private) " +
      "VALUES (?, ?, ?, ?, ?, 'upload', 1, ?, 'queued', ?) " +
      "ON CONFLICT (source_path) WHERE origin = 'upload' DO UPDATE SET source_path=excluded.source_path RETURNING id",
    args: [kind, title, tags, dir, partSize, onDisk, isPrivate],
  });

  return NextResponse.json({ ok: true, jobId: Number(rs.rows[0]?.id ?? 0) });
}
