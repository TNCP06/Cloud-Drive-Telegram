import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Attach a subtitle file that is ALREADY stored on the drive (Telegram storage)
// to a video part. Proxies the Python streamer, which downloads the small file
// from the channel, converts it to WebVTT, and stores it on /subtitles.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STREAMER_URL = process.env.STREAMER_URL || "http://streamer:8080";

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
  const { srcPartId, lang } = await req.json().catch(() => ({}));
  if (!Number.isInteger(srcPartId) || srcPartId <= 0 || !/^[a-z]{2,8}$/i.test(String(lang ?? "id"))) {
    return NextResponse.json({ error: "Bad source part or language." }, { status: 400 });
  }
  try {
    const headers: Record<string, string> = { Connection: "close" };
    if (process.env.STREAMER_SECRET) headers["X-Streamer-Secret"] = process.env.STREAMER_SECRET;
    const resp = await fetch(
      `${STREAMER_URL}/subtitles/${partId}/from-part/${srcPartId}?lang=${encodeURIComponent(String(lang ?? "id"))}`,
      { method: "POST", headers }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.detail ?? "Attaching subtitle failed." },
        { status: resp.status }
      );
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Subtitle service unavailable." }, { status: 502 });
  }
}
