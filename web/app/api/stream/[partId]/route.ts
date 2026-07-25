import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";
import { db } from "@/lib/db";

// Proxy authenticated streaming requests to the Python streamer service.
// Excluded from middleware (avoids edge-runtime body-size limit), so auth
// is checked manually here — same pattern as the upload route.
export const runtime = "nodejs";
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

  // UI-only demo (see lib/db.ts): there is no streamer and no Telegram, so a part's
  // `file_id` holds the path of a static demo asset instead of a Telegram file id.
  // Redirecting hands the request to the CDN, which serves Range requests itself —
  // so seeking, PDF preview and inline images all behave exactly as in production.
  if (process.env.DEMO_MODE === "1") {
    const rs = await db.execute({
      sql: "SELECT file_id FROM parts WHERE id = ?",
      args: [Number(partId)],
    });
    const asset = String(rs.rows[0]?.file_id ?? "");
    if (!asset.startsWith("/demo/")) {
      return new NextResponse("Not found", { status: 404 });
    }
    // A RELATIVE Location (legal per RFC 7231 §7.1.2) keeps the redirect same-origin.
    // `NextResponse.redirect` would resolve against the request URL, which can carry a
    // different host than the browser used (localhost vs 127.0.0.1, or a proxy) — and the
    // cross-origin hop then fails the CORS check in DocPreview's `fetch`.
    return new NextResponse(null, { status: 307, headers: { Location: asset } });
  }

  const upstream = `${STREAMER_URL}/stream/${partId}`;

  // Forward Range header if present (required for <video> seeking).
  // Disable Keep-Alive (Connection: close) to ensure Uvicorn completes the request cycle
  // and promotes completed chunks to cache without socket deadlocks.
  const headers: Record<string, string> = {
    Connection: "close",
  };
  // Shared secret so a publicly-exposed streamer (Cloudflare Tunnel) only serves the dashboard.
  if (process.env.STREAMER_SECRET) headers["X-Streamer-Secret"] = process.env.STREAMER_SECRET;
  const range = req.headers.get("Range");
  if (range) headers["Range"] = range;

  try {
    const resp = await fetch(upstream, { headers, signal: req.signal });

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

    // Stream the body through safely. We use a TransformStream to catch 
    // upstream disconnects or browser aborts without crashing the Node process.
    if (!resp.body) {
      return new Response(null, { status: resp.status, headers: relay });
    }

    return new Response(resp.body, { status: resp.status, headers: relay });
  } catch (err) {
    console.error("[stream proxy] fetch error:", err);
    return NextResponse.json(
      { error: "Streaming service unavailable." },
      { status: 502 }
    );
  }
}
