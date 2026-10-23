import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";
import { authorizePart } from "@/lib/resourceAuth";

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
  req: NextRequest,
  { params }: { params: Promise<{ partId: string }> }
) {
  if (!(await checkAuth())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { partId } = await params;
  const id = Number(partId);
  if (!Number.isInteger(id) || id <= 0 || !(await authorizePart(id))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const source = req.nextUrl.searchParams.get("source") || "orig";
  const target = req.nextUrl.searchParams.get("target") || "id";
  if (!/^[a-z]{2,8}$/i.test(source) || !/^[a-z]{2,8}$/i.test(target)) {
    return NextResponse.json({ error: "Bad language parameter." }, { status: 400 });
  }
  try {
    const resp = await fetch(
      `${STREAMER_URL}/subtitles/${partId}/translate?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
      {
        method: "POST",
        headers: streamerHeaders(),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.detail ?? "Translation failed." },
        { status: resp.status }
      );
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Subtitle service unavailable." }, { status: 502 });
  }
}
