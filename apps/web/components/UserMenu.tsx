"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { api, ApiError, type AuthUser } from "../lib/api";
import { Button, Badge } from "./ui";
import { useToast } from "./Toast";

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const valid = current.length > 0 && next.length >= 10 && next === confirm;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      await api.post("/auth/change-password", { currentPassword: current, newPassword: next });
      toast("Password changed.", "success");
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-overlay dark:border-white/10 dark:bg-ink-850"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold text-slate-900">Change password</div>
        <div className="mt-4 space-y-3">
          <input
            type="password"
            placeholder="Current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5"
          />
          <input
            type="password"
            placeholder="New password (10+ characters)"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5"
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5"
          />
        </div>
        {error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!valid} loading={busy}>Change password</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function UserMenu({ user, onSignedOut }: { user: AuthUser; onSignedOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const signOut = async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      onSignedOut();
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/15 dark:bg-white/[0.06] dark:text-slate-200 dark:hover:bg-white/[0.1]"
      >
        <span className="max-w-[10rem] truncate">{user.displayName}</span>
        <Badge value={user.role} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 z-30 mt-2 w-52 rounded-xl border border-slate-200 bg-white p-1.5 shadow-overlay dark:border-white/10 dark:bg-ink-850"
          >
            <button
              onClick={() => { setOpen(false); setChangingPassword(true); }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-white/10"
            >
              Change password
            </button>
            <button
              onClick={() => void signOut()}
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-white/10"
            >
              Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </div>
  );
}
