import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const STREAMER_URL = process.env.STREAMER_URL || "http://streamer:8080";

export async function GET() {
  try {
    const res = await fetch(`${STREAMER_URL}/logs`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

