import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Protect all routes. If APP_PASSWORD is not set → auth is DISABLED (no lock).
export async function middleware(req: NextRequest) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/login")) return NextResponse.next();

  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (token && token === (await sha256Hex(pw))) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // `sw.js` MUST be excluded: a Service Worker script served behind a 3xx redirect (the
  // /login bounce) is rejected by the browser ("script resource is behind a redirect").
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|api/upload|api/stream|api/seek-preview).*)"],
};
