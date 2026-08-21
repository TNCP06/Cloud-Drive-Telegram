import { NextResponse } from "next/server";
import { isAppAuthenticated } from "@/lib/apiAuth";

export const dynamic = "force-dynamic";

const STREAMER_URL = process.env.STREAMER_URL || "http://streamer:8080";

export async function GET() {
  if (!(await isAppAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const headers: Record<string, string> = {};
    if (process.env.STREAMER_SECRET) headers["X-Streamer-Secret"] = process.env.STREAMER_SECRET;
    const res = await fetch(`${STREAMER_URL}/logs`, { headers });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
