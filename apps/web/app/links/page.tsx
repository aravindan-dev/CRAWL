"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { api, artifactUrl, type Page, type DiscoveredLink, type BlockedLink } from "../../lib/api";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { Card, Button } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { Reveal, Stagger, Item } from "../../components/motion";
import { Icons } from "../../components/icons";

const PAGE_SIZE = 50;

/** Hostname (without www.) for a URL — used for the site-preview tile + favicon. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * A readable label for a discovered link. Prefers the REAL extracted programme
 * name (e.g. "Bachelor of Nursing"), then the page title, and only falls back to
 * a name derived from the URL slug (e.g. a bare subject code) as a last resort.
 */
function linkName(l: DiscoveredLink): string {
  const course = l.course_criteria?.[0]?.course_name?.trim();
  if (course) return course;
  const title = l.page_title?.trim();
  if (title) return title;
  const url = l.final_url ?? l.url;
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const tail = segs.reverse().find((s) => /[a-z]{3,}/i.test(s));
    return tail ? tail.replace(/\.(html?|php|aspx|pdf)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "(untitled)";
  } catch {
    return "(untitled)";
  }
}

/**
 * The "Shot" cell: shows the real crawl screenshot when we captured one, otherwise
 * a proper site-preview tile (favicon + domain) so EVERY row has a visual — never a
 * bare "no shot". Doubtful / not-yet-crawled links only get the preview tile.
 */
function ShotCell({ shot, url }: { shot: string | null; url: string }) {
  if (shot) {
    return (
      <a href={shot} target="_blank" rel="noreferrer" title="Open full screenshot">
        <img src={shot} alt="screenshot" loading="lazy" className="h-12 w-[5.25rem] flex-none rounded-md border border-slate-200 object-cover object-top shadow-sm transition hover:scale-[1.04] dark:border-white/10" />
      </a>
    );
  }
  const host = hostOf(url);
  const fav = host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title="No live screenshot yet — showing the site preview"
      className="flex h-12 w-[5.25rem] flex-none flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border border-slate-200 bg-slate-50 px-1 text-center shadow-sm transition hover:bg-slate-100 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
    >
      {fav ? (
        <img src={fav} alt="" width={16} height={16} loading="lazy" className="h-4 w-4 rounded-sm" onError={(e) => { e.currentTarget.style.display = "none"; }} />
      ) : (
        <span className="text-slate-400"><Icons.link size={14} /></span>
      )}
      <span className="max-w-full truncate text-[8px] font-medium leading-none text-slate-500">{host ?? "preview"}</span>
    </a>
  );
}

type VerdictKey = "working" | "doubtful" | "bot" | "broken" | "server" | "irrelevant" | "unchecked";
const VERDICT: Record<VerdictKey, { label: string; cls: string; note: string }> = {
  working: { label: "Working", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300", note: "Loads fine — safe to use." },
  doubtful: { label: "Doubtful", cls: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300", note: "Couldn't confirm — needs a check." },
  bot: { label: "Bot-blocked", cls: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300", note: "Site blocked our request (anti-bot). Verified in a real browser at export." },
  broken: { label: "Broken", cls: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300", note: "404 / gone — will be removed from exports." },
  server: { label: "Server error", cls: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300", note: "Site returned a 5xx error." },
  irrelevant: { label: "Not relevant", cls: "bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400", note: "Not an eligibility page." },
  unchecked: { label: "Not checked", cls: "bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400", note: "Not validated yet — click Re-validate." },
};

function verdictOf(l: DiscoveredLink): VerdictKey {
  const h = l.http_status;
  if (h !== null && h >= 200 && h < 300) return "working";
  if (h === 403 || h === 429 || l.status === "BLOCKED") return "bot";
  if (h === 404 || h === 410 || l.status === "BROKEN_LINK") return "broken";
  if (h !== null && h >= 500) return "server";
  if (["VALID_COURSE_PAGE", "VALID_ADMISSION_PAGE", "POSSIBLE_REQUIREMENT_PAGE"].includes(l.status)) return "working";
  if (l.status === "LOW_CONFIDENCE_PAGE") return "doubtful";
  if (l.status === "NOT_RELEVANT" || l.status === "REJECTED_CROSS_CONTEXT") return "irrelevant";
  return "unchecked";
}

const FILTERS = [
  { v: "", l: "All links" },
  { v: "VALID_COURSE_PAGE", l: "Working — course" },
  { v: "VALID_ADMISSION_PAGE", l: "Working — admission" },
  { v: "POSSIBLE_REQUIREMENT_PAGE", l: "Working — requirements" },
  { v: "LOW_CONFIDENCE_PAGE", l: "Doubtful" },
  { v: "BLOCKED", l: "Bot-blocked" },
  { v: "BROKEN_LINK", l: "Broken (404)" },
  { v: "PDF_DEFERRED", l: "PDF" },
  { v: "REJECTED_CROSS_CONTEXT", l: "Cross-context (never fetched)" },
];

const selectCls = "rounded-lg border border-slate-300 bg-white/60 px-3 py-1.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5";

export default function LinksPage() {
  const [items, setItems] = useState<DiscoveredLink[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [reval, setReval] = useState<{ running: boolean; done: number; total: number } | null>(null);
  const [rowBusy, setRowBusy] = useState<string>("");
  const [blocked, setBlocked] = useState<BlockedLink[]>([]);
  const [showBlocked, setShowBlocked] = useState(true);

  // --- Pagination: cursor-based, with a small history stack so Prev/Next both work.
  const [pageIndex, setPageIndex] = useState(0);
  const cursorsRef = useRef<(string | undefined)[]>([undefined]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  // --- Live "URLs being added" indicator: flash +N whenever the total grows.
  const [liveDelta, setLiveDelta] = useState(0);
  const prevTotalRef = useRef<number | null>(null);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadBlocked = useCallback(async () => {
    try {
      const r = await api.get<{ items: BlockedLink[] }>("/links/blocked");
      setBlocked(r.items);
    } catch { /* api may be down */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      params.set("take", String(PAGE_SIZE));
      const cursor = cursorsRef.current[pageIndex];
      if (cursor) params.set("cursor", cursor);
      const page = await api.get<Page<DiscoveredLink>>(`/links?${params.toString()}`);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      if (typeof page.total === "number") {
        const prev = prevTotalRef.current;
        if (prev !== null && page.total > prev) {
          const delta = page.total - prev;
          setLiveDelta(delta);
          clearTimeout(liveTimerRef.current);
          liveTimerRef.current = setTimeout(() => setLiveDelta(0), 4500);
        }
        prevTotalRef.current = page.total;
        setTotal(page.total);
      }
    } finally {
      setLoading(false); // clears the initial skeleton; silent on later refreshes
    }
  }, [status, pageIndex]);

  // Re-fetch whenever the page or filter changes; blocked list once alongside.
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadBlocked(); }, [loadBlocked]);
  useEffect(() => () => clearTimeout(liveTimerRef.current), []);
  // Live + reflects crawl/validate actions from other pages.
  useAutoRefresh(() => { void load(); void loadBlocked(); }, 4000);

  // Poll batch re-validation progress while it runs.
  useEffect(() => {
    if (!reval?.running) return;
    const t = setInterval(async () => {
      const p = await api.get<{ running: boolean; done: number; total: number }>("/links/revalidate-progress");
      setReval(p);
      if (!p.running) { clearInterval(t); await load(); await loadBlocked(); }
    }, 1500);
    return () => clearInterval(t);
  }, [reval?.running, load, loadBlocked]);

  const changeStatus = (v: string) => {
    // New filter → reset paging + the live baseline so it doesn't false-flash.
    setStatus(v);
    cursorsRef.current = [undefined];
    prevTotalRef.current = null;
    setLiveDelta(0);
    setPageIndex(0);
  };

  const goNext = () => {
    if (!nextCursor) return;
    cursorsRef.current[pageIndex + 1] = nextCursor;
    setPageIndex((i) => i + 1);
  };
  const goPrev = () => setPageIndex((i) => Math.max(0, i - 1));

  const revalidateAll = async () => {
    const r = await api.post<{ started: boolean; total: number }>("/links/revalidate-all");
    setReval({ running: true, done: 0, total: r.total });
  };

  const recheck = async (id: string) => {
    setRowBusy(id);
    try { await api.post(`/links/${id}/revalidate`); await load(); } finally { setRowBusy(""); }
  };

  const counts = items.reduce<Record<string, number>>((a, l) => { const k = verdictOf(l); a[k] = (a[k] ?? 0) + 1; return a; }, {});

  const rangeFrom = total === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const rangeTo = pageIndex * PAGE_SIZE + items.length;

  return (
    <div className="space-y-6">
      {/* Sticky heading: the title, live indicator + verdict counts stay pinned to
          the top as you scroll the long links table. */}
      <div className="sticky top-14 z-30 -mx-5 border-b border-slate-200 bg-white/95 px-5 pb-3 pt-4 backdrop-blur-sm dark:border-white/10 dark:bg-ink-900/95 md:-mx-8 md:px-8 lg:-mx-10 lg:px-10">
        <PageHeader
          eyebrow="Data · Verdicts"
          title="Discovered Links"
          subtitle={<>Every link we found, with a clear verdict. Only <b>Working</b> URLs are exported; doubtful &amp; bot-blocked are flagged.</>}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {/* Live indicator — pulses while the feed is being watched, and flashes
                  +N whenever new URLs are added by a running crawl. */}
              <span className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-emerald-500" />
                Live
                <AnimatePresence>
                  {liveDelta > 0 && (
                    <motion.span
                      key={liveDelta}
                      initial={{ opacity: 0, scale: 0.7, x: -4 }}
                      animate={{ opacity: 1, scale: 1, x: 0 }}
                      exit={{ opacity: 0, scale: 0.7 }}
                      className="tnum rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white"
                    >
                      +{liveDelta} new
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
              <select value={status} onChange={(e) => changeStatus(e.target.value)} className={selectCls}>
                {FILTERS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}
              </select>
              {reval?.running ? (
                <span className="tnum flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
                  <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-brand-500" />
                  Validating {reval.done}/{reval.total}…
                </span>
              ) : (
                <Button onClick={revalidateAll}>Re-validate all</Button>
              )}
            </div>
          }
        />

        {/* Verdict counts (this page) */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {(["working", "doubtful", "bot", "broken"] as VerdictKey[]).map((k) => (
            <span key={k} className={`tnum rounded-full px-2.5 py-1 font-medium ${VERDICT[k].cls}`}>{VERDICT[k].label}: {counts[k] ?? 0}</span>
          ))}
          {total !== null && (
            <span className="tnum ml-auto rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-500 dark:bg-white/10 dark:text-slate-300">{total.toLocaleString()} total links</span>
          )}
        </div>
      </div>

      {/* Bot-protected attempts — exact page/university/course we tried */}
      {blocked.length > 0 && (
        <Reveal>
          <Card className="overflow-hidden border-orange-200/70 dark:border-orange-500/20">
            <button
              onClick={() => setShowBlocked((s) => !s)}
              className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300">
                  <Icons.bot size={18} />
                </span>
                <div>
                  <div className="flex items-center gap-2 font-semibold text-slate-900">
                    Bot-protected attempts
                    <span className="tnum rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 dark:bg-orange-500/15 dark:text-orange-300">{blocked.length}</span>
                  </div>
                  <div className="text-xs text-slate-500">Exact pages, universities &amp; courses that blocked our request — verified in a real browser at export.</div>
                </div>
              </div>
              <motion.span animate={{ rotate: showBlocked ? 180 : 0 }} transition={{ duration: 0.2 }} className="text-slate-400">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg>
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {showBlocked && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.22, 0.7, 0.2, 1] }}
                  className="overflow-hidden"
                >
                  <Stagger className="max-h-[26rem] space-y-2 overflow-y-auto border-t border-orange-200/60 p-4 dark:border-orange-500/20" gap={0.03}>
                    {blocked.map((b) => (
                      <Item key={b.id}>
                        <div className="rounded-xl border border-slate-100 bg-white/50 p-3 transition-colors hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Icons.university size={15} className="text-slate-400" />
                            <span className="font-medium text-slate-800">{b.university?.name ?? "Unknown university"}</span>
                            {b.university?.country && <span className="text-xs text-slate-400">· {b.university.country}</span>}
                            <span className="ml-auto flex items-center gap-2">
                              <span className="tnum rounded-md bg-rose-100 px-1.5 py-0.5 font-mono text-[11px] text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">HTTP {b.http_status ?? "—"}</span>
                              <span className="tnum text-[11px] text-slate-400">{b.retry_count} {b.retry_count === 1 ? "try" : "tries"}</span>
                            </span>
                          </div>
                          <div className="mt-1 text-sm text-slate-700">{b.page_title || "(untitled page)"}</div>
                          <a href={b.final_url ?? b.url} target="_blank" rel="noreferrer" className="mt-0.5 flex items-center gap-1 break-all text-xs text-brand-600 hover:underline">
                            <Icons.external size={12} /> {b.final_url ?? b.url}
                          </a>
                          {b.course_criteria.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {b.course_criteria.map((c, i) => (
                                <span key={i} className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">{c.course_name}{c.degree_level ? ` · ${c.degree_level}` : ""}</span>
                              ))}
                            </div>
                          )}
                          {b.error_message && <div className="mt-1 text-xs text-slate-400">Reason: {b.error_message}</div>}
                        </div>
                      </Item>
                    ))}
                  </Stagger>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>
        </Reveal>
      )}

      <Reveal>
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/60 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-white/5">
              <tr>
                <th className="px-4 py-3">Shot</th>
                <th className="px-4 py-3">Course / Page</th>
                <th className="px-4 py-3">Verdict</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">HTTP</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">Loading…</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">No links.</td></tr>}
              {items.map((l) => {
                const v = VERDICT[verdictOf(l)];
                const shot = artifactUrl(l.screenshot_path);
                const url = l.final_url ?? l.url;
                const degree = l.course_criteria?.[0]?.degree_level;
                return (
                  <tr key={l.id} className="border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/50 dark:border-white/5 dark:hover:bg-white/5">
                    <td className="px-4 py-3">
                      <ShotCell shot={shot} url={url} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-slate-800">{linkName(l)}</span>
                        {degree && degree !== "Other" && (
                          <span className="flex-none rounded bg-teal-100 px-1.5 py-0.5 text-[10px] font-medium text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">{degree}</span>
                        )}
                      </div>
                      <a href={url} target="_blank" rel="noreferrer" className="break-all text-xs text-brand-600 hover:underline">{url}</a>
                    </td>
                    <td className="px-4 py-3"><span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${v.cls}`} title={v.note}>{v.label}</span></td>
                    <td className="tnum px-4 py-3 font-mono text-slate-500">{l.link_score}</td>
                    <td className="tnum px-4 py-3 font-mono text-slate-500">{l.http_status ?? "—"}</td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" disabled={rowBusy === l.id} onClick={() => recheck(l.id)}>{rowBusy === l.id ? "…" : "Re-check"}</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>

          {/* Pagination — browse ALL collected links, page by page. */}
          {(pageIndex > 0 || nextCursor) && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm dark:border-white/5">
              <span className="tnum text-slate-500">
                Showing <b>{rangeFrom.toLocaleString()}–{rangeTo.toLocaleString()}</b>
                {total !== null && <> of <b>{total.toLocaleString()}</b></>} · page {pageIndex + 1}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="secondary" disabled={pageIndex === 0} onClick={goPrev}>← Prev</Button>
                <Button variant="secondary" disabled={!nextCursor} onClick={goNext}>Next →</Button>
              </div>
            </div>
          )}
        </Card>
      </Reveal>

      <p className="text-xs text-slate-400">
        <b>Re-validate all</b> checks the eligibility links live and updates verdicts automatically. <b>Bot-blocked</b> pages are sites that block automated requests — the export step opens them in a real browser to confirm, so genuine pages still make it through.
      </p>
    </div>
  );
}
