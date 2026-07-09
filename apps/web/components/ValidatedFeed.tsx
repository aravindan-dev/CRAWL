"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ValidatedUrl } from "../lib/api";
import { timeAgo, localDateTime } from "../lib/time";
import { Card, Button } from "./ui";
import { Icons } from "./icons";

/** Colour a live crawl-time verdict. */
function verdictTone(v: string): string {
  if (v === "WORKING") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
  if (v === "BROWSER_VERIFIED") return "bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300";
  if (v === "BROKEN") return "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300";
  return "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300";
}

/** A readable name: the course name, else a slug from the URL tail. */
function prettyName(r: ValidatedUrl): string {
  if (r.course_name && r.course_name.trim()) return r.course_name.trim();
  if (r.level === "university") return "University eligibility page";
  try {
    const segs = new URL(r.url).pathname.split("/").filter(Boolean);
    const tail = segs.reverse().find((s) => /[a-z]{3,}/i.test(s));
    const name = tail ? tail.replace(/\.(html?|php|aspx)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "";
    return name || (r.level === "scholarship" ? "Scholarship / funding page" : "Course page");
  } catch {
    return r.level === "scholarship" ? "Scholarship / funding page" : "Course page";
  }
}

/** Colours + label for each of the three URL categories. */
const LEVEL_TAG: Record<"university" | "course" | "scholarship", { label: string; cls: string }> = {
  university: { label: "University", cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" },
  course: { label: "Course", cls: "bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300" },
  scholarship: { label: "Scholarship", cls: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" },
};

/**
 * LIVE "Validated URLs" feed for the Crawl & Validate page. As the single-pass
 * engine crawls each URL and validates it inline, the confirmed links stream in
 * here one-by-one (newest first) — straight from the DB, no export needed. This is
 * the "watch it find correct links live" view the whole single-pass flow is for.
 */
interface FeedCounts {
  university: number;
  course: number;
  scholarship: number;
  total: number;
}

export function ValidatedFeed() {
  const [items, setItems] = useState<ValidatedUrl[]>([]);
  const [counts, setCounts] = useState<FeedCounts | null>(null);
  const [q, setQ] = useState("");
  const [level, setLevel] = useState<"all" | "university" | "course" | "scholarship">("all");
  const [copied, setCopied] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      // 1000 (the display cap) — after Revalidate the feed holds EVERY validated
      // course URL (267+ for one university alone), so 300 undercounted the list.
      // The headline COUNTS come from `counts` (computed server-side over the FULL
      // validated set), so they stay correct even past the 1000-row display cap —
      // this is what stopped the "validated" total sliding backward.
      const r = await api.get<{ items: ValidatedUrl[]; counts?: FeedCounts }>("/links/validated?limit=1000");
      setItems(r.items);
      if (r.counts) setCounts(r.counts);
      setLoaded(true);
    } catch {
      /* api may be momentarily down between polls */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000); // live while the crawl runs
    return () => clearInterval(t);
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((r) => {
      if (level !== "all" && r.level !== level) return false;
      if (!needle) return true;
      return (
        r.url.toLowerCase().includes(needle) ||
        r.course_name.toLowerCase().includes(needle) ||
        r.university.toLowerCase().includes(needle)
      );
    });
  }, [items, q, level]);

  // Prefer the authoritative server counts (full validated set); fall back to the
  // loaded page only until the first response arrives (or an older API without
  // `counts`). This is why the badges no longer slide backward past the cap.
  const uniCount = counts?.university ?? items.filter((r) => r.level === "university").length;
  const courseCount = counts?.course ?? items.filter((r) => r.level === "course").length;
  const scholarshipCount = counts?.scholarship ?? items.filter((r) => r.level === "scholarship").length;
  const totalCount = counts?.total ?? items.length;

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(filtered.map((r) => r.url).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const Pill = ({ k, label }: { k: "all" | "university" | "course" | "scholarship"; label: string }) => (
    <button
      type="button"
      onClick={() => setLevel(k)}
      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
        level === k ? "bg-brand-600 text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 dark:bg-white/5 dark:text-slate-300"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-semibold text-slate-900">
          <span className="h-2.5 w-2.5 flex-none animate-pulse rounded-full bg-emerald-500" />
          Validated URLs · live
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">{uniCount} university</span>
          <span className="rounded-full bg-teal-50 px-2 py-0.5 font-medium text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">{courseCount} course</span>
          <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">{scholarshipCount} scholarship</span>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">{totalCount} validated</span>
        </div>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Each link the engine crawls <b>and validates inline</b> appears here instantly — newest first. <span className="text-indigo-600 dark:text-indigo-300">University</span> = eligibility pages, <span className="text-teal-600 dark:text-teal-300">Course</span> = individual courses (with name). At <a href="/revalidate" className="text-brand-600 hover:underline">Revalidate</a>, university-level is reduced to <b>one main eligibility URL per university</b>; every course URL is kept.
      </p>

      {/* Toolbar */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by university, course or URL…"
            className="w-full rounded-lg border border-slate-300 bg-white/60 py-1.5 pl-8 pr-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Pill k="all" label="All" />
          <Pill k="university" label="University" />
          <Pill k="course" label="Course" />
          <Pill k="scholarship" label="Scholarship" />
        </div>
        <Button variant="secondary" onClick={copyAll} disabled={filtered.length === 0}>{copied ? "Copied!" : "Copy URLs"}</Button>
      </div>

      {/* Live list */}
      <div className="mt-3 max-h-[28rem] space-y-1.5 overflow-y-auto pr-1">
        {!loaded && <div className="py-10 text-center text-sm text-slate-400">Loading…</div>}
        {loaded && items.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300/70 px-6 py-10 text-center dark:border-white/10">
            <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-white/5"><Icons.link size={20} /></div>
            <div className="text-sm font-semibold text-slate-700">No validated URLs yet</div>
            <div className="mt-1 max-w-sm text-sm text-slate-500">Start the engine and Crawl all — validated links will stream in here one-by-one as each page is crawled &amp; confirmed.</div>
          </div>
        )}
        {loaded && items.length > 0 && filtered.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-400">No validated URLs match the filter.</div>
        )}

        {filtered.map((r) => (
            <div
              key={r.id}
              className="rounded-xl border border-slate-100 bg-white/50 p-2.5 transition-colors hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={`flex-none rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${LEVEL_TAG[r.level].cls}`}>{LEVEL_TAG[r.level].label}</span>
                  <span className="truncate text-sm font-medium text-slate-800">{prettyName(r)}</span>
                </span>
                <span className="flex flex-none items-center gap-1.5">
                  {r.http_status && <span className="tnum font-mono text-[11px] text-slate-400">HTTP {r.http_status}</span>}
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${verdictTone(r.verdict)}`}>{r.verdict}</span>
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                <Icons.university size={11} /> <span className="truncate">{r.university}{r.country ? ` · ${r.country}` : ""}</span>
                <span className="ml-auto flex flex-none items-center gap-1 whitespace-nowrap" title={localDateTime(r.updated_at)}>
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                  {timeAgo(r.updated_at)}
                </span>
              </div>
              <a href={r.url} target="_blank" rel="noreferrer" className="mt-0.5 block break-all text-xs text-brand-600 hover:underline">{r.url}</a>
              {r.anchor_url && (
                <a
                  href={r.anchor_url}
                  target="_blank"
                  rel="noreferrer"
                  title="Same-page entry-requirements section (secondary — the main course URL above is what exports)"
                  className="mt-0.5 flex items-center gap-1 break-all text-[11px] text-teal-600 hover:underline dark:text-teal-300"
                >
                  <svg viewBox="0 0 24 24" className="h-3 w-3 flex-none" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></svg>
                  <span className="break-all">{r.anchor_url.replace(/^https?:\/\/[^/]+/, "")}</span>
                </a>
              )}
              {r.evidence && <div className="mt-1 truncate text-[11px] italic text-slate-500" title={r.evidence}>“…{r.evidence}…”</div>}
            </div>
          ))}
      </div>
    </Card>
  );
}
