import { cookies } from "next/headers";
import { AUTH_COOKIE, sha256Hex } from "./auth";

export async function isAppAuthenticated(): Promise<boolean> {
  const password = process.env.APP_PASSWORD;
  if (!password) return true;
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return !!token && token === (await sha256Hex(password));
}
