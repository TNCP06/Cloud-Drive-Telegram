"use client";

import { useActionState } from "react";
import { Icon } from "@/lib/icons";
import { login } from "./actions";
import type { LoginState } from "@/lib/auth";

export function LoginForm({ from }: { from: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, null);

  return (
    <div className="login-wrap">
      <form action={action} className="login-card">
        <div className="login-mark">
          <Icon name="cloud" size={24} stroke={1.7} />
        </div>
        <h1>Vault</h1>
        <p className="login-sub">Masukkan password untuk masuk</p>

        <input type="hidden" name="from" value={from} />
        <input
          className="input"
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          required
          autoComplete="current-password"
        />
        {state?.error && <div className="login-err">{state.error}</div>}

        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? <span className="spinner sm" /> : <Icon name="check" size={16} />}
          Masuk
        </button>
      </form>
    </div>
  );
}
