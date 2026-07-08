"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Stats } from "../lib/api";
import { StatCard } from "../components/ui";
import { Icons } from "../components/icons";
import { Hero, type HeroChip } from "../components/Hero";
import { Stagger, Item, Reveal } from "../components/motion";

interface Progress { completed: number; total: number; links: number; intlLinks: number }
interface Counts { universityUrls: number; courseUrls: number; totalUrls: number }
interface Crawler { running: boolean }

type State = "done" | "active" | "todo";

export default function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [crawler, setCrawler] = useState<Crawler | null>(null);
  const [apiDown, setApiDown] = useState(false);

  useEffect(() => {
    const tick = async () => {
      try {
        const [s, p, c, cr] = await Promise.all([
          api.get<Stats>("/stats"),
          api.get<Progress>("/ops/crawl-progress"),
          api.get<Counts>("/ops/export-counts"),
          api.get<Crawler>("/ops/crawler"),
        ]);
        setStats(s); setProgress(p); setCounts(c); setCrawler(cr); setApiDown(false);
      } catch { setApiDown(true); }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);

  const unis = stats?.total_universities ?? 0;
  const completed = progress?.completed ?? 0;
  const total = progress?.total ?? 0;
  const valid = stats?.total_valid_links ?? 0;
  const found = stats?.total_links_discovered ?? 0;
  const exported = counts?.totalUrls ?? 0;

  const chips: HeroChip[] = [
    { label: "universities", value: unis, accent: "brand" },
    { label: "working links", value: valid.toLocaleString(), accent: "emerald" },
    { label: "URLs exported", value: exported.toLocaleString(), accent: "amber" },
    { label: "crawled", value: total ? `${completed}/${total}` : "—", accent: "slate" },
  ];

  const steps: { n: number; href: string; icon: React.ReactNode; title: string; detail: string; state: State }[] = [
    { n: 1, href: "/universities", icon: <Icons.university />, title: "Add universities", detail: unis > 0 ? `${unis} added` : "Upload Excel/CSV or add manually", state: unis > 0 ? "done" : "active" },
    { n: 2, href: "/crawl", icon: <Icons.crawl />, title: "Crawl & Validate", detail: crawler?.running ? `Running — ${completed}/${total} universities` : valid > 0 ? `${valid.toLocaleString()} validated of ${found.toLocaleString()} found` : total > 0 ? `${completed}/${total} crawled` : "One pass: crawl each URL & validate it live", state: crawler?.running ? "active" : completed > 0 && completed === total && total > 0 ? "done" : unis > 0 ? "active" : "todo" },
    { n: 3, href: "/revalidate", icon: <Icons.shield />, title: "Revalidate", detail: exported > 0 ? `${exported.toLocaleString()} URLs · de-duped, 404s removed` : "Remove duplicates, drop 404s, write final files", state: exported > 0 ? "done" : valid > 0 ? "active" : "todo" },
    { n: 4, href: "/export", icon: <Icons.operations />, title: "Export & Aliff", detail: exported > 0 ? "Build inputs, push to Aliff, download" : "Push validated links into Aliff (login)", state: exported > 0 ? "active" : "todo" },
  ];

  const dot: Record<State, string> = { done: "bg-emerald-500", active: "bg-brand-500 animate-pulse", todo: "bg-slate-300 dark:bg-white/15" };
  const ringCls: Record<State, string> = { done: "ring-emerald-500/20", active: "ring-brand-500/30", todo: "ring-transparent" };

  return (
    <div className="space-y-7">
      <Hero
        eyebrow="Local-first · International eligibility"
        title="CLG Search"
        subtitle="Automatically extract course & university eligibility / criteria URLs for international-entry students. One pass crawls AND validates each link live, a fast revalidate de-dupes & drops 404s, then it pushes to Aliff. Follow the 4 steps below; everything updates live."
        chips={chips}
      />

      {apiDown && (
        <Reveal>
          <div className="glass border-rose-200/70 p-3 text-sm text-rose-700 dark:text-rose-300">
            API offline — run <code>start.bat</code> (or <code>scripts\run-api.bat</code>). Steps go live once it's up.
          </div>
        </Reveal>
      )}

      {/* Live pipeline */}
      <div>
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Icons.pulse size={16} /> Pipeline · live
        </div>
        <Stagger className="relative space-y-3">
          {/* connecting spine behind the badges */}
          <div aria-hidden className="pointer-events-none absolute bottom-8 left-[39px] top-8 w-px bg-slate-200 dark:bg-white/10" />
          {steps.map((s) => (
            <Item key={s.n}>
              <Link href={s.href} className={`glass group relative flex items-center gap-4 p-4 ring-1 transition-shadow duration-150 hover:border-slate-300 hover:shadow-card-hover dark:hover:border-white/[0.14] ${ringCls[s.state]}`}>
                <span className="relative z-10 flex h-11 w-11 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-600 ring-1 ring-black/5 dark:bg-white/10 dark:text-slate-200 dark:ring-white/10">
                  {s.icon}
                  <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-ink-900 ${dot[s.state]}`} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-slate-400">STEP {s.n}</span>
                    {s.state === "done" && <span className="text-emerald-500"><Icons.check size={14} /></span>}
                    {s.state === "active" && <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">NOW</span>}
                  </div>
                  <div className="font-semibold text-slate-900">{s.title}</div>
                  <div className="truncate text-sm text-slate-500">{s.detail}</div>
                </div>
                <span className="flex-none text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-500"><Icons.external size={18} /></span>
              </Link>
            </Item>
          ))}
        </Stagger>
      </div>

      {/* Deliverable totals */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Extracted eligibility URLs (validated)</h2>
        <Stagger className="grid grid-cols-2 gap-4 md:grid-cols-4" gap={0.06}>
          <Item><StatCard label="University URLs" value={counts ? counts.universityUrls : "—"} accent="text-brand-600" /></Item>
          <Item><StatCard label="Course URLs" value={counts ? counts.courseUrls : "—"} accent="text-brand-600" /></Item>
          <Item><StatCard label="Total URLs" value={counts ? counts.totalUrls : "—"} accent="text-emerald-600" /></Item>
          <Item><StatCard label="Universities crawled" value={progress ? `${completed}/${total}` : "—"} /></Item>
        </Stagger>
      </div>
    </div>
  );
}
