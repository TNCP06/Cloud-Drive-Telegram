import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readFile } from "fs/promises";
import { keptAuthOk, resolveKeptFile, subSiblingPath } from "@/lib/keptSubs";

// Serve one WebVTT subtitle track for a kept-on-server file (sibling file on the /staging volume).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; lang: string }> }
) {
  if (!(await keptAuthOk())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id, lang } = await params;
  if (!/^[a-z]{2,8}$/i.test(lang)) {
    return NextResponse.json({ error: "Bad language." }, { status: 400 });
  }
  const kf = await resolveKeptFile(Number(id));
  if (!kf) return new Response("Not found", { status: 404 });
  let body: string;
  try {
    body = await readFile(subSiblingPath(kf.full, lang.toLowerCase()), "utf-8");
  } catch {
    return new Response("Not found", { status: 404 });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
