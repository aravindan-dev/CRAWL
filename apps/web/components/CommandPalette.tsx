"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { startRouteProgress } from "./RouteProgress";

interface Cmd { label: string; href: string; hint: string; group: string }
const COMMANDS: Cmd[] = [
  { label: "Home", href: "/", hint: "Live pipeline overview", group: "Overview" },
  { label: "Guide", href: "/guide", hint: "How to use it", group: "Overview" },
  { label: "1 · Universities", href: "/universities", hint: "Add & import", group: "Pipeline" },
  { label: "2 · Crawl & Validate", href: "/crawl", hint: "Single pass: crawl + validate live", group: "Pipeline" },
  { label: "3 · Revalidate", href: "/revalidate", hint: "De-dup, drop 404s, write final files", group: "Pipeline" },
  { label: "4 · Export & Aliff", href: "/export", hint: "Build inputs, push to Aliff, download", group: "Pipeline" },
  { label: "Review links", href: "/links", hint: "Verdicts & re-validate", group: "Advanced" },
  { label: "Download files", href: "/exports", hint: "Download URL files", group: "Advanced" },
  { label: "Coverage", href: "/coverage", hint: "Course coverage & review queue", group: "Advanced" },
  { label: "Change Monitor", href: "/monitor", hint: "NEW / CHANGED / BROKEN / FIXED", group: "Advanced" },
  { label: "Logs", href: "/logs", hint: "Live activity log", group: "Advanced" },
  { label: "Settings", href: "/settings", hint: "All parameters", group: "Configure" },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) { setQ(""); setActive(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? COMMANDS.filter((c) => (c.label + " " + c.hint).toLowerCase().includes(s)) : COMMANDS;
  }, [q]);

  const go = (href: string) => { setOpen(false); startRouteProgress(); router.push(href); };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-start justify-center bg-slate-900/40 p-4 pt-[12vh]"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -6 }}
            transition={{ type: "spring", stiffness: 500, damping: 36 }}
            className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white shadow-overlay dark:border-white/10 dark:bg-ink-850"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 dark:border-white/10">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => { setQ(e.target.value); setActive(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                  else if (e.key === "Enter" && results[active]) { go(results[active]!.href); }
                }}
                placeholder="Jump to a page…"
                className="w-full bg-transparent py-3.5 text-sm outline-none placeholder:text-slate-400"
              />
              <kbd className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-400 dark:border-white/15">ESC</kbd>
            </div>
            <div className="max-h-80 overflow-y-auto p-2">
              {results.length === 0 && <div className="px-3 py-6 text-center text-sm text-slate-400">No matches.</div>}
              {results.map((c, i) => (
                <button
                  key={c.href}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(c.href)}
                  className={`relative flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                    i === active ? "text-brand-700 dark:text-brand-200" : "text-slate-700 hover:bg-slate-50 dark:hover:bg-white/5"
                  }`}
                >
                  {i === active && (
                    <motion.span layoutId="cmd-active" transition={{ type: "spring", stiffness: 500, damping: 38 }} className="absolute inset-0 -z-10 rounded-lg bg-brand-50 dark:bg-brand-500/15" />
                  )}
                  <span className="font-medium">{c.label}</span>
                  <span className="text-xs text-slate-400">{c.hint}</span>
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
