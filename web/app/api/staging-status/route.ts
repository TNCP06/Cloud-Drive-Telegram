import { NextResponse } from "next/server";
import { activeStagingJobs, BACKUP_PAUSE_BYTES, BACKUP_RESUME_BYTES, pendingStagingBytes, stagingFreeBytes } from "@/lib/stagingHealth";
import { isAppAuthenticated } from "@/lib/apiAuth";

// Staging-volume health for the backup/upload UI: free disk, bytes still
// waiting for the Telegram upload, and active job count. The client uses this
// to pace itself (auto-pause when the VPS disk runs tight) instead of blindly
// staging files until the volume fills up. pauseBelow/resumeAbove carry the
// effective server thresholds so the UI never hardcodes them.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAppAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const [pendingBytes, activeJobs] = await Promise.all([
    pendingStagingBytes(),
    activeStagingJobs(),
  ]);
  return NextResponse.json({
    freeBytes: stagingFreeBytes(),
    pendingBytes,
    activeJobs,
    pauseBelow: BACKUP_PAUSE_BYTES,
    resumeAbove: BACKUP_RESUME_BYTES,
  });
}
