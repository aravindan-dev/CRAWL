"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "./ui";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "accent";

/**
 * A button that asks for confirmation in a modal before running an action.
 * Use for anything destructive or outward-facing (delete, reset, restart, LIVE).
 */
export function ConfirmButton({
  label,
  title,
  message,
  confirmLabel = "Confirm",
  variant = "danger",
  disabled,
  confirmPhrase,
  onConfirm,
}: {
  label: ReactNode;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  variant?: Variant;
  disabled?: boolean;
  /** If set, the user must TYPE this exact word (e.g. "DELETE") to enable confirm. */
  confirmPhrase?: string;
  onConfirm: () => Promise<unknown> | unknown;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [typed, setTyped] = useState("");
  const phraseOk = !confirmPhrase || typed.trim().toUpperCase() === confirmPhrase.toUpperCase();

  // Portal target: render the dialog on <body> so it ESCAPES Framer-Motion's
  // transformed page wrapper. A position:fixed element inside a transformed
  // ancestor is positioned relative to that ancestor (not the viewport), which
  // is why the dialog was squashed over the card — the portal fixes that.
  useEffect(() => setMounted(true), []);

  // Lock background scroll while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [open, busy]);

  const dialog = (
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
            onClick={() => !busy && setOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ type: "spring", stiffness: 360, damping: 28 }}
              className="ring-gradient w-full max-w-md rounded-2xl border border-white/60 bg-white/90 p-6 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-ink-800/95"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3">
                {variant === "danger" && (
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300">
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
                  </span>
                )}
                <div className="text-lg font-semibold text-slate-900">{title}</div>
              </div>
              <div className="mt-2 text-sm text-slate-600">{message}</div>
              {confirmPhrase && (
                <div className="mt-4">
                  <label className="text-xs font-medium text-slate-500">Type <span className="font-mono font-bold text-rose-600 dark:text-rose-300">{confirmPhrase}</span> to confirm</label>
                  <input
                    autoFocus
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={confirmPhrase}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white/70 px-3 py-2 text-sm font-mono outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-400/30 dark:bg-white/5"
                  />
                </div>
              )}
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
                <Button
                  variant={variant}
                  disabled={busy || !phraseOk}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onConfirm();
                      setOpen(false);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Working…" : confirmLabel}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
  );

  return (
    <>
      <Button variant={variant} disabled={disabled} onClick={() => { setTyped(""); setOpen(true); }}>
        {label}
      </Button>
      {mounted ? createPortal(dialog, document.body) : null}
    </>
  );
}
