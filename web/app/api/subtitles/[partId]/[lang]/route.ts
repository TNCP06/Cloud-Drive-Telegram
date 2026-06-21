import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Serve one WebVTT subtitle track. Proxies the Python streamer.
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
  _req: NextRequest,
  { params }: { params: Promise<{ partId: string; lang: string }> }
) {
  if (!(await checkAuth())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { partId, lang } = await params;
  // Only allow simple language codes (defense-in-depth; the streamer also validates).
  if (!/^[a-z]{2,8}$/i.test(lang)) {
    return NextResponse.json({ error: "Bad language." }, { status: 400 });
  }
  try {
    const headers: Record<string, string> = { Connection: "close" };
    if (process.env.STREAMER_SECRET) headers["X-Streamer-Secret"] = process.env.STREAMER_SECRET;
    const resp = await fetch(`${STREAMER_URL}/subtitles/${partId}/${lang}`, { headers });
    if (!resp.ok) {
      return new Response("Not found", { status: resp.status });
    }
    const body = await resp.text();
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("Subtitle service unavailable.", { status: 502 });
  }
}
