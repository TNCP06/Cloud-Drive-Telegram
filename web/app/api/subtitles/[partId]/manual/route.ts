import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Upload a manual subtitle file (SRT/VTT/ASS/…) for a video part. Proxies the
// Python streamer, which converts it to WebVTT and stores it on /subtitles.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STREAMER_URL = process.env.STREAMER_URL || "http://streamer:8080";
const MAX_SUB_BYTES = 10 * 1048576;

async function checkAuth(): Promise<boolean> {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true;
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return !!token && token === (await sha256Hex(pw));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ partId: string }> }
) {
  if (!(await checkAuth())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { partId } = await params;
  const lang = req.nextUrl.searchParams.get("lang") ?? "id";
  const ext = req.nextUrl.searchParams.get("ext") ?? "srt";
  if (!/^[a-z]{2,8}$/i.test(lang) || !/^[a-z0-9]{2,5}$/i.test(ext)) {
    return NextResponse.json({ error: "Bad language or extension." }, { status: 400 });
  }
  const body = Buffer.from(await req.arrayBuffer());
  if (!body.length || body.length > MAX_SUB_BYTES) {
    return NextResponse.json({ error: "Empty or too-large subtitle file." }, { status: 400 });
  }
  try {
    const headers: Record<string, string> = {
      Connection: "close",
      "Content-Type": "application/octet-stream",
    };
    if (process.env.STREAMER_SECRET) headers["X-Streamer-Secret"] = process.env.STREAMER_SECRET;
    const resp = await fetch(
      `${STREAMER_URL}/subtitles/${partId}/manual?lang=${encodeURIComponent(lang)}&ext=${encodeURIComponent(ext)}`,
      { method: "POST", headers, body }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.detail ?? "Subtitle upload failed." },
        { status: resp.status }
      );
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Subtitle service unavailable." }, { status: 502 });
  }
}
