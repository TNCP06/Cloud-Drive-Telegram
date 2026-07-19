import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { writeFile } from "fs/promises";
import { keptAuthOk, resolveKeptFile, subSiblingPath, toVtt } from "@/lib/keptSubs";

// Upload a subtitle file (SRT/VTT) for a kept-on-server file. Converted to WebVTT and written as a
// sibling next to the kept file on the shared /staging volume. Raw body = the file bytes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SUB_BYTES = 10 * 1048576;
const ALLOWED_EXTS = new Set(["srt", "vtt"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await keptAuthOk())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id } = await params;
  const lang = req.nextUrl.searchParams.get("lang") ?? "id";
  const ext = (req.nextUrl.searchParams.get("ext") ?? "srt").toLowerCase();
  if (!/^[a-z]{2,8}$/i.test(lang)) {
    return NextResponse.json({ error: "Bad language code." }, { status: 400 });
  }
  if (!ALLOWED_EXTS.has(ext)) {
    return NextResponse.json(
      { error: "Only .srt and .vtt subtitle files are supported." },
      { status: 400 }
    );
  }
  const kf = await resolveKeptFile(Number(id));
  if (!kf) return NextResponse.json({ error: "File not found." }, { status: 404 });

  const body = Buffer.from(await req.arrayBuffer());
  if (!body.length || body.length > MAX_SUB_BYTES) {
    return NextResponse.json({ error: "Empty or too-large subtitle file." }, { status: 400 });
  }
  let vtt: string;
  try {
    vtt = toVtt(body.toString("utf-8"), ext);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read the subtitle file." },
      { status: 422 }
    );
  }
  await writeFile(subSiblingPath(kf.full, lang.toLowerCase()), vtt, "utf-8");
  return NextResponse.json({ ok: true, lang: lang.toLowerCase() });
}
