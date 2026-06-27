import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Proxy seek-preview VTT requests to the Python streamer.
// Auth mirrors the main /api/stream proxy.
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
  const reqUrl = new URL(req.url);
  const wait = reqUrl.searchParams.get("wait") === "true";
  const upstream = `${STREAMER_URL}/seek-preview/${partId}${wait ? "?wait=true" : ""}`;

  const headers: Record<string, string> = {};
  if (process.env.STREAMER_SECRET)
    headers["X-Streamer-Secret"] = process.env.STREAMER_SECRET;

  try {
    const resp = await fetch(upstream, { headers, signal: req.signal });
    if (!resp.ok) {
      if (resp.status === 404) {
        // No preview for this part. Return an empty body (parses to 0 cues) rather than
        // "WEBVTT\n\n" (which Plyr mis-parses as a bogus cue). The client never feeds this to
        // Plyr anyway — VideoPlayer probes here first and only enables previewThumbnails when a
        // valid VTT exists, since Plyr's parser crashes on a zero-cue track (reading frames[0].text).
        return new Response("", {
          status: 200,
          headers: {
            "Content-Type": "text/vtt",
            "Cache-Control": "no-store",
          },
        });
      }
      return new Response(null, { status: resp.status });
    }

    // The VTT references "sprite" as a relative URL.  Rewrite it to the
    // absolute proxy path so the browser fetches it through our auth proxy.
    let vtt = await resp.text();
    vtt = vtt.replace(
      /^sprite#/gm,
      `/api/seek-preview/${partId}/sprite#`
    );

    return new Response(vtt, {
      status: 200,
      headers: {
        "Content-Type": "text/vtt",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Streaming service unavailable." },
      { status: 502 }
    );
  }
}
