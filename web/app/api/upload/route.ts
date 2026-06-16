import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { mkdir, stat, appendFile } from "node:fs/promises";
import { jobDir, stagedFilePath } from "@/lib/staging";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Resumable upload endpoint (chunked). The browser sends a big file in sequential
// chunks; if the connection drops, it asks GET for the current offset and resumes
// from there instead of restarting. Must run on a Node server (next start) — NOT a
// Vercel serverless function, whose small body limit would break large uploads.
//
// This route is excluded from middleware (to bypass the 10 MB middleware body-size
// limit), so it performs its own cookie auth check below.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAUTHORIZED = () =>
  NextResponse.json({ error: "Unauthorized." }, { status: 401 });

async function checkAuth(): Promise<boolean> {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true; // no password set → auth disabled
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return !!token && token === (await sha256Hex(pw));
}

async function sizeOf(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}

// GET ?token=&name=  → how many bytes the server already has (for resume).
export async function GET(req: NextRequest) {
  if (!(await checkAuth())) return UNAUTHORIZED();
  const sp = req.nextUrl.searchParams;
  const token = sp.get("token") ?? "";
  const name = sp.get("name") ?? "";
  let file: string;
  try {
    file = stagedFilePath(token, name);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  return NextResponse.json({ received: await sizeOf(file) });
}

// POST ?token=&name=&offset=  body=raw chunk bytes  → append, return new size.
// If offset doesn't match what we have, reply 409 with the real offset so the
// client re-syncs (this is what makes a flaky connection safe).
export async function POST(req: NextRequest) {
  if (!(await checkAuth())) return UNAUTHORIZED();
  const sp = req.nextUrl.searchParams;
  const token = sp.get("token") ?? "";
  const name = sp.get("name") ?? "";
  const offset = Number(sp.get("offset") ?? "0");

  let file: string;
  try {
    file = stagedFilePath(token, name);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return NextResponse.json({ error: "Bad offset." }, { status: 400 });
  }

  await mkdir(jobDir(token), { recursive: true });

  const current = await sizeOf(file);
  if (offset !== current) {
    // Client is out of sync (e.g. a retried chunk). Tell it where we actually are.
    return NextResponse.json({ received: current }, { status: 409 });
  }

  const body = Buffer.from(await req.arrayBuffer());
  if (body.length === 0) {
    return NextResponse.json({ received: current });
  }
  await appendFile(file, body);
  return NextResponse.json({ received: current + body.length });
}
