"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { api, type UniversityUrls, type VerifiedUrl } from "../lib/api";
import { Badge, Button } from "./ui";
import { Icons } from "./icons";

/** Colour a validity verdict from the verified export. */
function validityTone(v: string): string {
  if (v === "WORKING") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
  if (v === "BROWSER_VERIFIED") return "bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300";
  if (v === "UNCONFIRMED") return "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300";
  return "bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300";
}

/**
 * Slide-in panel showing the EXACT verified URLs that shipped for one university
 * (read from the validated export files). Polls while open so newly-exported URLs
 * appear live. Reused by the Universities and Crawl pages.
 */
export function UniversityUrlsDrawer({
  universityId,
  onClose,
}: {
  universityId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<UniversityUrls | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!universityId) return;
    try {
      setData(await api.get<UniversityUrls>(`/universities/${universityId}/urls`));
    } catch {
      /* api may be momentarily down */
    } finally {
      setLoading(false);
    }
  }, [universityId]);

  // Load on open + poll live while the drawer is open.
  useEffect(() => {
    if (!universityId) return;
    setData(null);
    setQ("");
    setLoading(true);
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [universityId, load]);

  // Close on Escape.
  useEffect(() => {
    if (!universityId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [universityId, onClose]);

  const items = data?.items ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (r) => r.course_name.toLowerCase().includes(needle) || r.url.toLowerCase().includes(needle),
    );
  }, [items, q]);

  const uni = filtered.filter((r) => r.level === "university");
  const courses = filtered.filter((r) => r.level === "course");
  const scholarships = filtered.filter((r) => r.level === "scholarship");

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(filtered.map((r) => r.url).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  return (
    <AnimatePresence>
      {universityId && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm"
          />
          <motion.aside
            key="panel"
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 38 }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-ink-900"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-5 dark:border-white/10">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Icons.link size={16} className="flex-none text-brand-500" />
                  <h2 className="truncate text-base font-semibold text-slate-900">{data?.university.name ?? "Verified URLs"}</h2>
                  {data && <Badge value={data.university.crawl_status} />}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Verified from the validated export: <b>one main university eligibility URL</b> + every <b>course</b> URL (with its course name) + every <b>scholarship</b> URL.
                </p>
                {data && (
                  <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                    <span className="rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">{data.counts.universityUrls} main university URL</span>
                    <span className="rounded-full bg-teal-50 px-2 py-0.5 font-medium text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">{data.counts.courseUrls} course URLs</span>
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">{data.counts.scholarshipUrls ?? 0} scholarship URLs</span>
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">{data.counts.validUrls} total verified</span>
                  </div>
                )}
              </div>
              <button onClick={onClose} aria-label="Close" className="flex-none rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 dark:border-white/5">
              <div className="relative flex-1">
                <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
                <input
                  value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by course or URL…"
                  className="w-full rounded-lg border border-slate-300 bg-white/60 py-1.5 pl-8 pr-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5"
                />
              </div>
              <Button variant="secondary" onClick={copyAll} disabled={filtered.length === 0}>{copied ? "Copied!" : "Copy URLs"}</Button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5">
              {loading && !data && <div className="py-10 text-center text-sm text-slate-400">Loading…</div>}
              {data && items.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300/70 px-6 py-12 text-center dark:border-white/10">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-white/5">
                    <Icons.link size={22} />
                  </div>
                  <div className="text-sm font-semibold text-slate-700">No verified URLs yet</div>
                  <div className="mt-1 max-w-sm text-sm text-slate-500">
                    These appear once this university has been validated &amp; exported. Run <a href="/revalidate" className="text-brand-600 hover:underline">Revalidate</a>, then check back — only confirmed, correct URLs are shown.
                  </div>
                </div>
              )}
              {data && items.length > 0 && filtered.length === 0 && (
                <div className="py-10 text-center text-sm text-slate-400">No URLs match “{q}”.</div>
              )}

              {uni.length > 0 && (
                <Section kind="university" title="University eligibility · main URL" count={uni.length} rows={uni} />
              )}
              {courses.length > 0 && (
                <div className={uni.length > 0 ? "mt-5" : ""}>
                  <Section kind="course" title="Course eligibility URLs" count={courses.length} rows={courses} />
                </div>
              )}
              {scholarships.length > 0 && (
                <div className={uni.length + courses.length > 0 ? "mt-5" : ""}>
                  <Section kind="scholarship" title="Scholarship URLs" count={scholarships.length} rows={scholarships} />
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

/** A readable name for a row: the course/scholarship name, else a slug from the URL tail. */
function prettyName(r: VerifiedUrl): string {
  if (r.course_name && r.course_name.trim()) return r.course_name.trim();
  if (r.level === "university") return "Main entry-requirements page";
  const fallback = r.level === "scholarship" ? "Scholarship page" : "Course page";
  try {
    const segs = new URL(r.url).pathname.split("/").filter(Boolean);
    const tail = segs.reverse().find((s) => /[a-z]{3,}/i.test(s));
    return tail ? tail.replace(/\.(html?|php|aspx)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : fallback;
  } catch {
    return fallback;
  }
}

/** Per-kind colours + row tag so the three sections stay visually distinct. */
const KIND_STYLE: Record<"university" | "course" | "scholarship", { dot: string; tag: string; tagText: string }> = {
  university: { dot: "bg-indigo-500", tag: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300", tagText: "Main" },
  course: { dot: "bg-teal-500", tag: "bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300", tagText: "Course" },
  scholarship: { dot: "bg-amber-500", tag: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300", tagText: "Scholarship" },
};

function Section({ kind, title, count, rows }: { kind: "university" | "course" | "scholarship"; title: string; count: number; rows: VerifiedUrl[] }) {
  const isUni = kind === "university";
  const style = KIND_STYLE[kind];
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span className={`h-1 w-1 rounded-full ${style.dot}`} />{title}
        <span className="tnum rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-white/10">{count}</span>
      </div>
      {isUni && <p className="mb-2 -mt-1 text-[11px] text-slate-400">The single main eligibility / entry-requirements page for this university.</p>}
      {kind === "scholarship" && <p className="mb-2 -mt-1 text-[11px] text-slate-400">Individual scholarship records from the scholarship export (listing/blog/fee pages removed).</p>}
      <ul className="space-y-1.5">
        {rows.map((r, i) => (
          <li key={`${r.url}-${i}`} className="rounded-xl border border-slate-100 bg-white/50 p-2.5 transition-colors hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`flex-none rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${style.tag}`}>{style.tagText}</span>
                <span className="truncate text-sm font-medium text-slate-800">{prettyName(r)}</span>
              </span>
              <span className="flex flex-none items-center gap-1.5">
                {r.http_status && <span className="tnum font-mono text-[11px] text-slate-400">HTTP {r.http_status}</span>}
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${validityTone(r.validity)}`}>{r.validity}</span>
              </span>
            </div>
            <a href={r.url} target="_blank" rel="noreferrer" className="mt-0.5 block break-all text-xs text-brand-600 hover:underline">{r.url}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
