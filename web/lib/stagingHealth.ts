import "server-only";
import { statfsSync } from "node:fs";
import { db } from "./db";
import { STAGING_ROOT } from "./staging";

// Shared staging-volume health for the browser-upload pipeline. The watcher
// needs headroom on this same volume for its per-part window copy (≤ partSize)
// while a job runs, so the finalize endpoint refuses new jobs when the disk is
// too tight instead of jamming the whole queue mid-upload.
// All tunables are env-driven (see .env.example) so disk policy can be changed
// without a code deploy — the backup page reads the effective values from
// /api/staging-status instead of hardcoding them.
function numEnv(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export const STAGING_HEADROOM_BYTES =
  numEnv("STAGING_HEADROOM_MB", 512) * 1024 * 1024;

const _pauseGb = numEnv("BACKUP_PAUSE_GB", 3);
let _resumeGb = numEnv("BACKUP_RESUME_GB", 4.5);
if (_resumeGb <= _pauseGb) _resumeGb = _pauseGb * 1.5; // hysteresis must hold
export const BACKUP_PAUSE_BYTES = _pauseGb * 1024 * 1024 * 1024;
export const BACKUP_RESUME_BYTES = _resumeGb * 1024 * 1024 * 1024;

/** Free bytes on the staging volume, or null when it cannot be determined. */
export function stagingFreeBytes(): number | null {
  return stagingStat()?.free ?? null;
}

/** { free, total } bytes on the staging volume, or null when unreadable. */
export function stagingStat(): { free: number; total: number } | null {
  try {
    const s = statfsSync(STAGING_ROOT);
    return {
      free: Number(s.bfree) * Number(s.bsize),
      total: Number(s.blocks) * Number(s.bsize),
    };
  } catch {
    return null;
  }
}

/** Bytes already staged but not yet pushed to Telegram (queued/pending/running). */
export async function pendingStagingBytes(): Promise<number> {
  try {
    const rs = await db.execute(
      "SELECT COALESCE(SUM(total_bytes),0) AS b FROM upload_jobs " +
        "WHERE origin='upload' AND status IN ('queued','pending','running')"
    );
    const row = rs.rows[0] as { b?: unknown } | undefined;
    return Number(row?.b ?? 0);
  } catch {
    return 0;
  }
}

/** Active browser-origin jobs (still holding staging disk). */
export async function activeStagingJobs(): Promise<number> {
  try {
    const rs = await db.execute(
      "SELECT COUNT(*) AS c FROM upload_jobs " +
        "WHERE origin='upload' AND status IN ('queued','pending','running')"
    );
    const row = rs.rows[0] as { c?: unknown } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}
