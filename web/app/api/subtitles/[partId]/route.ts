import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// List the subtitle languages available for a part. Proxies the Python streamer,
// which reads them off its persistent /subtitles volume.
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
  { params }: { params: Promise<{ partId: string }> }
) {
  if (!(await checkAuth())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { partId } = await params;
  try {
    const headers: Record<string, string> = { Connection: "close" };
    if (process.env.STREAMER_SECRET) headers["X-Streamer-Secret"] = process.env.STREAMER_SECRET;
    const resp = await fetch(`${STREAMER_URL}/subtitles/${partId}`, { headers });
    if (!resp.ok) return NextResponse.json({ langs: [], done: false });
    const data = await resp.json();
    return NextResponse.json({
      langs: Array.isArray(data?.langs) ? data.langs : [],
      done: data?.done === true,
    });
  } catch {
    // Streamer unreachable → no captions, but don't break playback.
    return NextResponse.json({ langs: [], done: false });
  }
}
