import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { keptAuthOk, resolveKeptFile, listKeptSubLangs } from "@/lib/keptSubs";

// List the subtitle languages uploaded for a kept-on-server file. `done` is always true — kept
// files have no background STT generation, so the player never polls for more (see VideoPlayer).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await keptAuthOk())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id } = await params;
  const kf = await resolveKeptFile(Number(id));
  if (!kf) return NextResponse.json({ langs: [], done: true });
  return NextResponse.json({ langs: await listKeptSubLangs(kf.full), done: true });
}
