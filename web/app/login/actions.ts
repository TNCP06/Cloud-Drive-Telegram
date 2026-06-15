"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE, sha256Hex, type LoginState } from "@/lib/auth";

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const pw = process.env.APP_PASSWORD;
  if (!pw) redirect("/"); // auth nonaktif

  const input = String(formData.get("password") ?? "");
  if (input !== pw) return { error: "Password salah." };

  const c = await cookies();
  c.set(AUTH_COOKIE, await sha256Hex(pw), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 hari
  });

  const from = String(formData.get("from") || "/");
  redirect(from.startsWith("/") ? from : "/");
}

export async function logout() {
  const c = await cookies();
  c.delete(AUTH_COOKIE);
  redirect("/login");
}
