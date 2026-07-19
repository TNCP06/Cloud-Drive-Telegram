import { NextResponse } from "next/server";
import { cookies } from "next/headers";

// Beacon target: clears the Private unlock cookie (tcd_priv, see app/actions/private.ts) when the
// user leaves /private by a full-page unload — tab close, hard reload, URL change — so returning
// always re-prompts for the PIN. SPA navigations are handled by PrivateAutoLock's unmount instead.
export async function POST() {
  (await cookies()).delete("tcd_priv");
  return new NextResponse(null, { status: 204 });
}
