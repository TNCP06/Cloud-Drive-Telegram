import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import fs from "fs";
import path from "path";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";
import { db } from "@/lib/db";
import { authorizePart } from "@/lib/resourceAuth";

// Proxy seek-preview sprite image requests to the Python streamer (or serve static demo sprites in DEMO_MODE).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STREAMER_URL = process.env.STREAMER_URL || "http://streamer:8080";

async function checkAuth(): Promise<boolean> {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true;
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return !!token && token === (await sha256Hex(pw));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ partId: string }> }
) {
  if (!(await checkAuth())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { partId } = await params;
  const id = Number(partId);
  if (!Number.isInteger(id) || id <= 0 || !(await authorizePart(id))) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (process.env.DEMO_MODE?.trim() === "1") {
    const rs = await db.execute({
      sql: "SELECT file_id FROM parts WHERE id = ?",
      args: [id],
    });
    const asset = String(rs.rows[0]?.file_id ?? "");
    const filename = path.basename(asset);
    const stem = filename.substring(0, filename.lastIndexOf("."));
    const previewsDir = fs.existsSync(path.join(process.cwd(), "public", "demo", "previews"))
      ? path.join(process.cwd(), "public", "demo", "previews")
      : path.join(process.cwd(), "web", "public", "demo", "previews");
    const spriteFile = path.join(previewsDir, `${stem}.jpg`);

    try {
      const buffer = await fs.promises.readFile(spriteFile);
      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(buffer.byteLength),
          "Cache-Control": "public, max-age=604800, immutable",
        },
      });
    } catch {
      return new NextResponse("Not found", { status: 404 });
    }
  }

  const upstream = `${STREAMER_URL}/seek-preview/${partId}/sprite`;

  const headers: Record<string, string> = {};
  if (process.env.STREAMER_SECRET)
    headers["X-Streamer-Secret"] = process.env.STREAMER_SECRET;

  try {
    const resp = await fetch(upstream, { headers, signal: req.signal });
    if (!resp.ok) {
      return new Response(null, { status: resp.status });
    }

    const relay = new Headers();
    relay.set("Content-Type", "image/jpeg");
    relay.set("Cache-Control", "private, max-age=604800, immutable");
    const cl = resp.headers.get("content-length");
    if (cl) relay.set("Content-Length", cl);

    return new Response(resp.body, { status: 200, headers: relay });
  } catch {
    return NextResponse.json(
      { error: "Streaming service unavailable." },
      { status: 502 }
    );
  }
}
