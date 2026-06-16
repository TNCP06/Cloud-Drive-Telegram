import "server-only";
import path from "node:path";
import os from "node:os";

// Shared staging directory for browser (resumable) uploads. The web writes files
// here; the watcher reads them (source_path = the job dir). In Docker, both the web
// and watcher containers MUST mount the same volume at this exact path
// (UPLOAD_STAGING_DIR=/staging). On a single host (laptop dev) the default tmp dir
// is shared by both processes automatically.
export const STAGING_ROOT =
  process.env.UPLOAD_STAGING_DIR || path.join(os.tmpdir(), "tcd_uploads");

// A job token is a client-generated id (uuid-ish). Keep it strictly to a safe set
// so it can never escape the staging root.
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Absolute path of a job's staging dir. Throws on a malformed token. */
export function jobDir(token: string): string {
  if (!isValidToken(token)) throw new Error("Invalid upload token.");
  return path.join(STAGING_ROOT, token);
}

/** Absolute path of one staged file, guaranteed to stay inside the job dir. */
export function stagedFilePath(token: string, name: string): string {
  const base = path.basename(String(name)).replace(/[\\/]/g, "").trim();
  if (!base || base === "." || base === ".." || base.includes("..")) {
    throw new Error("Invalid file name.");
  }
  const dir = jobDir(token);
  const full = path.join(dir, base);
  const rel = path.relative(dir, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Invalid file path.");
  return full;
}
