// Simple single-password auth based on APP_PASSWORD env var.
// The cookie stores SHA-256(password), not the raw password.
// Shared by middleware (edge) and server actions — both have access to Web Crypto.

export const AUTH_COOKIE = "tcd_auth";

export type LoginState = { error?: string } | null;

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
