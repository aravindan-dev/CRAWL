"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, type LicenseStatus } from "../lib/api";
import { Icons } from "./icons";

const APP_VERSION = "1.0.0";

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
      { href: "/license", label: "License" },
    ],
  },
  {
    title: "Configure",
    links: [
      { href: "/settings", label: "Settings" },
      { href: "/users", label: "Team accounts" },
    ],
  },
];

// Nav entries only ADMIN should see (the API enforces this server-side too —
// hiding them is cosmetic, not the actual security boundary).
const ADMIN_ONLY_HREFS = new Set(["/settings", "/users"]);

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
  "/license": <Icons.lock />,
  "/users": <Icons.users />,
};

const LICENSE_DOT: Record<string, string> = {
  valid: "bg-emerald-500",
  grace: "bg-amber-500",
  invalid: "bg-rose-500",
};

interface RunStatus { running: { label: string } | null }

export function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [running, setRunning] = useState<{ label: string } | null>(null);
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [licenseState, setLicenseState] = useState<string | null>(null);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [role, setRole] = useState<string | null>(null);

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

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.get<LicenseStatus>("/license/status");
        if (alive) { setLicenseState(s.state); setLicense(s); }
      } catch {
        /* license status is non-critical for nav rendering */
      }
    };
    tick();
    const t = setInterval(tick, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.get<{ user: { role: string } | null }>("/auth/me");
        if (alive) setRole(r.user?.role ?? null);
      } catch {
        /* role is non-critical for nav rendering */
      }
    };
    tick();
    const t = setInterval(tick, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const sections = SECTIONS.map((s) => ({
    ...s,
    links: s.links.filter((l) => !ADMIN_ONLY_HREFS.has(l.href) || role === "ADMIN"),
  })).filter((s) => s.links.length > 0);

  return (
    <div className="flex h-full w-full flex-col border-r border-slate-200 bg-white dark:border-white/[0.08] dark:bg-ink-900">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
          CS
        </div>
        <div>
          <div className="text-base font-bold leading-tight tracking-tight text-slate-900">CLG Search</div>
          <div className="text-[11px] leading-tight text-slate-500">Eligibility URL extractor</div>
        </div>
      </div>

      {/* Live status pill */}
      <div className="px-4 pb-2">
        {running ? (
          <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800 ring-1 ring-inset ring-brand-500/20 dark:bg-brand-500/10 dark:text-brand-200">
            <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-brand-500" />
            <span className="truncate">Running: {running.label}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 ring-1 ring-inset ring-slate-200/80 dark:bg-white/[0.04] dark:ring-white/10">
            <span className={`h-2 w-2 flex-none rounded-full ${apiUp === false ? "bg-rose-500" : "bg-emerald-500"}`} />
            <span>{apiUp === false ? "API offline — start run-api.bat" : "Idle · ready"}</span>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
        {sections.map((s) => (
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
                    className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                      active
                        ? "text-brand-700 dark:text-brand-200"
                        : "text-slate-600 hover:bg-slate-100/70 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/[0.05] dark:hover:text-white"
                    }`}
                  >
                    {active && (
                      <span className="absolute inset-0 -z-10 rounded-lg bg-brand-50 ring-1 ring-inset ring-brand-500/15 dark:bg-brand-500/10" />
                    )}
                    <span className={`flex-none ${active ? "text-brand-600 dark:text-brand-300" : "text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-200"}`}>
                      {ICONS[l.href]}
                    </span>
                    <span className="truncate">{l.label}</span>
                    {l.href === "/license" && licenseState && (
                      <span className={`ml-auto h-2 w-2 flex-none rounded-full ${LICENSE_DOT[licenseState] ?? "bg-slate-300"}`} />
                    )}
                    {l.step && (
                      <span className={`ml-auto flex h-4 w-4 flex-none items-center justify-center rounded text-[10px] font-bold ${active ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400"}`}>{l.step}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-slate-200 px-5 py-3 text-[11px] leading-tight text-slate-400 dark:border-white/[0.08]">
        <div>CLG Search v{APP_VERSION}</div>
        {license?.state !== "invalid" && license?.customerName ? (
          <div className="truncate">
            Licensed to {license.customerName}
            {license.expiresAt && <> · expires {new Date(license.expiresAt).toLocaleDateString()}</>}
          </div>
        ) : (
          <div>For international-entry students · Local-first</div>
        )}
      </div>
    </div>
  );
}
