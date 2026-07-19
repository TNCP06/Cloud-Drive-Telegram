import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Softsub extraction: POST starts a background job on the Python streamer that
// downloads the ORIGINAL video from Telegram and extracts its embedded text
// subtitle streams to WebVTT tracks; GET polls the job status.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STREAMER_URL = process.env.STREAMER_URL || "http://streamer:8080";

async function checkAuth(): Promise<boolean> {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true;
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return !!token && token === (await sha256Hex(pw));
}

function streamerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Connection: "close" };
  if (process.env.STREAMER_SECRET) headers["X-Streamer-Secret"] = process.env.STREAMER_SECRET;
  return headers;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ partId: string }> }
) {
  if (!(await checkAuth())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { partId } = await params;
  try {
    const resp = await fetch(`${STREAMER_URL}/subtitles/${partId}/extract`, {
      method: "POST",
      headers: streamerHeaders(),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.detail ?? "Could not start extraction." },
        { status: resp.status }
      );
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Subtitle service unavailable." }, { status: 502 });
  }
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
    const resp = await fetch(`${STREAMER_URL}/subtitles/${partId}/extract/status`, {
      headers: streamerHeaders(),
    });
    const data = await resp.json().catch(() => ({}));
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "error", message: "Subtitle service unavailable." });
  }
}
