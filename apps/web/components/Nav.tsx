"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { api } from "../lib/api";
import { Icons } from "./icons";

const SECTIONS: { title: string; links: { href: string; label: string; step?: number }[] }[] = [
  {
    title: "Overview",
    links: [
      { href: "/", label: "Home" },
      { href: "/guide", label: "Guide" },
    ],
  },
  {
    // The streamlined 3-process flow (after import): crawl & validate is now a
    // SINGLE pass, then a fast revalidate, then export + Aliff.
    title: "Pipeline",
    links: [
      { href: "/universities", label: "Universities", step: 1 },
      { href: "/crawl", label: "Crawl & Validate", step: 2 },
      { href: "/revalidate", label: "Revalidate", step: 3 },
      { href: "/export", label: "Export & Aliff", step: 4 },
    ],
  },
  {
    // Everything still here — just out of the main flow's way.
    title: "Advanced",
    links: [
      { href: "/links", label: "Review links" },
      { href: "/criteria", label: "Criteria" },
      { href: "/exports", label: "Download files" },
      { href: "/coverage", label: "Coverage" },
      { href: "/monitor", label: "Change Monitor" },
      { href: "/logs", label: "Logs (live)" },
      { href: "/storage", label: "Storage" },
    ],
  },
  {
    title: "Configure",
    links: [
      { href: "/settings", label: "Settings" },
    ],
  },
];

// One icon per route, from the unified icon set.
const ICONS: Record<string, ReactNode> = {
  "/": <Icons.home />,
  "/guide": <Icons.guide />,
  "/crawl": <Icons.crawl />,
  "/revalidate": <Icons.shield />,
  "/export": <Icons.operations />,
  "/operations": <Icons.operations />,
  "/exports": <Icons.download />,
  "/universities": <Icons.university />,
  "/criteria": <Icons.course />,
  "/coverage": <Icons.shield />,
  "/monitor": <Icons.pulse />,
  "/links": <Icons.link />,
  "/logs": <Icons.logs />,
  "/storage": <Icons.database />,
  "/settings": <Icons.settings />,
};

interface RunStatus { running: { label: string } | null }

export function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [running, setRunning] = useState<{ label: string } | null>(null);
  const [apiUp, setApiUp] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.get<RunStatus>("/ops/status");
        if (alive) { setRunning(s.running); setApiUp(true); }
      } catch {
        if (alive) { setRunning(null); setApiUp(false); }
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <div className="flex h-full w-full flex-col border-r border-white/50 bg-white/60 backdrop-blur-xl dark:border-white/10 dark:bg-ink-900/70">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white shadow-lg shadow-brand-600/40">
          CS
          <span className="absolute -inset-1 -z-10 rounded-2xl bg-brand-500/40 blur-md" />
        </div>
        <div>
          <div className="text-base font-bold leading-tight tracking-tight text-slate-900">CLG Search</div>
          <div className="text-[11px] leading-tight text-slate-500">Eligibility URL extractor</div>
        </div>
      </div>

      {/* Live status pill */}
      <div className="px-4 pb-2">
        {running ? (
          <div className="flex items-center gap-2 rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-800 ring-1 ring-inset ring-brand-500/20 dark:bg-brand-500/15 dark:text-brand-200">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" /></span>
            <span className="truncate">Running: {running.label}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500 ring-1 ring-inset ring-slate-200/70 dark:bg-white/5 dark:ring-white/10">
            <span className={`relative flex h-2 w-2`}>
              {apiUp !== false && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${apiUp === false ? "bg-rose-400" : "bg-emerald-500"}`} />
            </span>
            <span>{apiUp === false ? "API offline — start run-api.bat" : "Idle · ready"}</span>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
        {SECTIONS.map((s) => (
          <div key={s.title}>
            <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">{s.title}</div>
            <div className="space-y-0.5">
              {s.links.map((l) => {
                const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`group relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors duration-200 ${
                      active
                        ? "text-brand-700 dark:text-brand-200"
                        : "text-slate-600 hover:bg-slate-100/60 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/[0.05] dark:hover:text-white"
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="nav-active"
                        transition={{ type: "spring", stiffness: 420, damping: 34 }}
                        className="absolute inset-0 -z-10 rounded-xl bg-brand-50 shadow-sm shadow-brand-600/10 ring-1 ring-brand-500/20 dark:bg-brand-500/15"
                      />
                    )}
                    {active && <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-gradient-to-b from-brand-400 to-brand-600" />}
                    <span className={`flex-none transition-all duration-200 group-hover:scale-110 ${active ? "text-brand-600 dark:text-brand-300" : "text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-200"}`}>
                      {ICONS[l.href]}
                    </span>
                    <span className="truncate">{l.label}</span>
                    {l.step && (
                      <span className={`ml-auto flex h-4 w-4 flex-none items-center justify-center rounded-md text-[10px] font-bold ${active ? "bg-brand-500 text-white" : "bg-slate-200/70 text-slate-500 dark:bg-white/10 dark:text-slate-400"}`}>{l.step}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">For international-entry students · Local-first</div>
    </div>
  );
}
