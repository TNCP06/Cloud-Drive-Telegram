import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Proxy seek-preview sprite image requests to the Python streamer.
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
    relay.set("Cache-Control", "public, max-age=86400");
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
