"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { api, artifactUrl, type Page, type DiscoveredLink, type BlockedLink } from "../../lib/api";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { Card, Button } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { Reveal, Stagger, Item } from "../../components/motion";
import { Icons } from "../../components/icons";

/** A readable label for a discovered link: its page title, else a name from the URL slug. */
function linkName(title: string | null | undefined, url: string): string {
  if (title && title.trim()) return title.trim();
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const tail = segs.reverse().find((s) => /[a-z]{3,}/i.test(s));
    return tail ? tail.replace(/\.(html?|php|aspx|pdf)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "(untitled)";
  } catch {
    return "(untitled)";
  }
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
  if (l.status === "NOT_RELEVANT") return "irrelevant";
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

  const loadBlocked = useCallback(async () => {
    try {
      const r = await api.get<{ items: BlockedLink[] }>("/links/blocked");
      setBlocked(r.items);
    } catch { /* api may be down */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const qs = status ? `?status=${status}&take=150` : "?take=150";
      const page = await api.get<Page<DiscoveredLink>>(`/links${qs}`);
      setItems(page.items);
    } finally {
      setLoading(false); // clears the initial skeleton; silent on later refreshes
    }
  }, [status]);

  useEffect(() => { void load(); void loadBlocked(); }, [load, loadBlocked]);
  // Live + reflects crawl/validate actions from other pages.
  useAutoRefresh(() => { void load(); void loadBlocked(); }, 5000);

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

  const revalidateAll = async () => {
    const r = await api.post<{ started: boolean; total: number }>("/links/revalidate-all");
    setReval({ running: true, done: 0, total: r.total });
  };

  const recheck = async (id: string) => {
    setRowBusy(id);
    try { await api.post(`/links/${id}/revalidate`); await load(); } finally { setRowBusy(""); }
  };

  const counts = items.reduce<Record<string, number>>((a, l) => { const k = verdictOf(l); a[k] = (a[k] ?? 0) + 1; return a; }, {});

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Data · Verdicts"
        title="Discovered Links"
        subtitle={<>Every link we found, with a clear verdict. Only <b>Working</b> URLs are exported; doubtful &amp; bot-blocked are flagged.</>}
        actions={
          <div className="flex items-center gap-2">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls}>
              {FILTERS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}
            </select>
            {reval?.running ? (
              <span className="tnum flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
                <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" /></span>
                Validating {reval.done}/{reval.total}…
              </span>
            ) : (
              <Button onClick={revalidateAll}>Re-validate all</Button>
            )}
          </div>
        }
      />

      {/* Verdict legend + counts (this view) */}
      <Reveal>
        <div className="flex flex-wrap gap-2 text-xs">
          {(["working", "doubtful", "bot", "broken"] as VerdictKey[]).map((k) => (
            <span key={k} className={`tnum rounded-full px-2.5 py-1 font-medium ${VERDICT[k].cls}`}>{VERDICT[k].label}: {counts[k] ?? 0}</span>
          ))}
        </div>
      </Reveal>

      {/* Bot-protected attempts — exact page/university/course we tried */}
      {blocked.length > 0 && (
        <Reveal>
          <Card gradientRing className="overflow-hidden border-orange-200/70 dark:border-orange-500/20">
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
                <th className="px-4 py-3">Page / URL</th>
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
                return (
                  <tr key={l.id} className="border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/50 dark:border-white/5 dark:hover:bg-white/5">
                    <td className="px-4 py-3">
                      {shot ? (
                        <a href={shot} target="_blank" rel="noreferrer" title="Open full screenshot">
                          <img src={shot} alt="screenshot" loading="lazy" className="h-12 w-[5.25rem] flex-none rounded-md border border-slate-200 object-cover object-top shadow-sm transition hover:scale-[1.04] dark:border-white/10" />
                        </a>
                      ) : (
                        <span className="flex h-12 w-[5.25rem] items-center justify-center rounded-md border border-dashed border-slate-200 text-[10px] text-slate-300 dark:border-white/10" title="No screenshot — page not crawled yet">no shot</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{linkName(l.page_title, l.final_url ?? l.url)}</div>
                      <a href={l.final_url ?? l.url} target="_blank" rel="noreferrer" className="break-all text-xs text-brand-600 hover:underline">{l.final_url ?? l.url}</a>
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
        </Card>
      </Reveal>

      <p className="text-xs text-slate-400">
        <b>Re-validate all</b> checks the eligibility links live and updates verdicts automatically. <b>Bot-blocked</b> pages are sites that block automated requests — the export step opens them in a real browser to confirm, so genuine pages still make it through.
      </p>
    </div>
  );
}
