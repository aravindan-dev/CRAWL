"use client";

import { useState } from "react";
import { api, ApiError, type AuthUser } from "../lib/api";
import { Card, Button } from "./ui";

export function LoginPage({ customerName, onLoggedIn }: { customerName?: string; onLoggedIn: (user: AuthUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ user: AuthUser }>("/auth/login", { username: username.trim(), password });
      onLoggedIn(res.user);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 dark:bg-ink-950">
      <Card className="w-full max-w-sm p-8">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">CS</div>
          <h1 className="mt-4 text-lg font-semibold text-slate-900">Sign in to CLG Search</h1>
          {customerName && <p className="mt-1 text-xs text-slate-400">Licensed to {customerName}</p>}
        </div>

        <form
          className="mt-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Username</label>
            <input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5"
            />
          </div>
          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          <Button onClick={submit} disabled={!username.trim() || !password} loading={busy}>
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
