import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Proxy authenticated streaming requests to the Python streamer service.
// Excluded from middleware (avoids edge-runtime body-size limit), so auth
// is checked manually here — same pattern as the upload route.
export const runtime = "edge";
export const dynamic = "force-dynamic";

const STREAMER_URL = process.env.STREAMER_URL || "http://streamer:8080";

async function checkAuth(): Promise<boolean> {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true; // no password set → auth disabled
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
  const upstream = `${STREAMER_URL}/stream/${partId}`;

  // Forward Range header if present (required for <video> seeking).
  const headers: HeadersInit = {};
  const range = req.headers.get("Range");
  if (range) headers["Range"] = range;

  try {
    const resp = await fetch(upstream, { headers });

    // Relay status + relevant headers back to the browser.
    const relay = new Headers();
    for (const key of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
    ]) {
      const v = resp.headers.get(key);
      if (v) relay.set(key, v);
    }

    // Stream the body through without buffering.
    return new Response(resp.body, { status: resp.status, headers: relay });
  } catch (err) {
    console.error("[stream proxy]", err);
    return NextResponse.json(
      { error: "Streaming service unavailable." },
      { status: 502 }
    );
  }
}
