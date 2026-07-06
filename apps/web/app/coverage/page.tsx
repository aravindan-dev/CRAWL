"use client";

import { useCallback, useEffect, useState } from "react";
import { api, API_URL } from "../../lib/api";
import { Card, Button, StatCard, Skeleton, EmptyState } from "../../components/ui";
import { useToast } from "../../components/Toast";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { PageHeader } from "../../components/PageHeader";

interface UniSummary { id: string; name: string; country: string; total: number; found: number; shared: number; needsReview: number; notFound: number; status: "COMPLETE" | "INCOMPLETE" | "NO_DATA" }
interface Totals { total: number; found: number; shared: number; needsReview: number; notFound: number }
interface ReviewItem { linkId: string; university: string; courseName: string; courseUrl: string; suggested: string[]; evidenceText: string }

const STATUS_CLS: Record<string, string> = {
  COMPLETE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  INCOMPLETE: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  NO_DATA: "bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400",
};

export default function CoveragePage() {
  const toast = useToast();
  const [unis, setUnis] = useState<UniSummary[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [review, setReview] = useState<{ total: number; items: ReviewItem[] }>({ total: 0, items: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<{ running: boolean; done: number; total: number; mapped: number; provider: string; error?: string } | null>(null);
  const [predict, setPredict] = useState<{ running: boolean; done: number; total: number; mapped: number } | null>(null);
  const [search, setSearch] = useState<{ running: boolean; done: number; total: number; mapped: number; engine: string } | null>(null);
  const [resolve, setResolve] = useState<{ running: boolean; done: number; total: number; upgraded: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.get<{ universities: UniSummary[]; totals: Totals }>("/coverage");
      setUnis(s.universities);
      setTotals(s.totals);
      setReview(await api.get<{ total: number; items: ReviewItem[] }>("/coverage/review"));
    } catch { /* api may be down */ } finally { setLoading(false); }
  }, []);
  useAutoRefresh(load, 5000);

  // Poll AI auto-review progress while it runs.
  useEffect(() => {
    if (!ai?.running) return;
    const t = setInterval(async () => {
      const p = await api.get<{ running: boolean; done: number; total: number; mapped: number; provider: string }>("/coverage/ai-progress");
      setAi(p);
      if (!p.running) { clearInterval(t); toast(`AI mapped ${p.mapped} of ${p.total} courses.`, "success"); await load(); }
    }, 1500);
    return () => clearInterval(t);
  }, [ai?.running, load, toast]);

  const aiReview = async () => {
    const r = await api.post<{ started: boolean; total: number; provider: string }>("/coverage/ai-review");
    if (r.started) { setAi({ running: true, done: 0, total: r.total, mapped: 0, provider: r.provider }); toast(`AI reviewing ${r.total} courses with ${r.provider}…`, "info"); }
    else { const p = await api.get<{ error?: string }>("/coverage/ai-progress"); toast(p.error ?? "AI provider not available — set it in Settings.", "error"); }
  };

  // Poll URL-pattern prediction progress.
  useEffect(() => {
    if (!predict?.running) return;
    const t = setInterval(async () => {
      const p = await api.get<{ running: boolean; done: number; total: number; mapped: number }>("/coverage/predict-progress");
      setPredict(p);
      if (!p.running) { clearInterval(t); toast(`Predicted & verified ${p.mapped} eligibility URLs.`, "success"); await load(); }
    }, 1500);
    return () => clearInterval(t);
  }, [predict?.running, load, toast]);

  const predictUrls = async () => {
    const r = await api.post<{ started: boolean; total: number }>("/coverage/predict-urls");
    if (r.started) { setPredict({ running: true, done: 0, total: r.total, mapped: 0 }); toast(`Testing eligibility URL patterns for ${r.total} courses…`, "info"); }
  };

  // Poll free web-search fallback progress.
  useEffect(() => {
    if (!search?.running) return;
    const t = setInterval(async () => {
      const p = await api.get<{ running: boolean; done: number; total: number; mapped: number; engine: string }>("/coverage/search-progress");
      setSearch(p);
      if (!p.running) { clearInterval(t); toast(`Web search found & verified ${p.mapped} eligibility URLs.`, "success"); await load(); }
    }, 1500);
    return () => clearInterval(t);
  }, [search?.running, load, toast]);

  const searchFallback = async () => {
    const r = await api.post<{ started: boolean; total: number; engine: string }>("/coverage/search-fallback");
    if (r.started) { setSearch({ running: true, done: 0, total: r.total, mapped: 0, engine: r.engine }); toast(`Searching ${r.engine} (free) for ${r.total} courses…`, "info"); }
  };

  // Poll "get exact URLs" (#entry-requirements / admission-requirements) progress.
  useEffect(() => {
    if (!resolve?.running) return;
    const t = setInterval(async () => {
      const p = await api.get<{ running: boolean; done: number; total: number; upgraded: number }>("/coverage/resolve-progress");
      setResolve(p);
      if (!p.running) { clearInterval(t); toast(`Upgraded ${p.upgraded} courses to their exact eligibility URL.`, "success"); await load(); }
    }, 1500);
    return () => clearInterval(t);
  }, [resolve?.running, load, toast]);

  const resolveExact = async () => {
    const r = await api.post<{ started: boolean; total: number }>("/coverage/resolve-exact");
    if (r.started) { setResolve({ running: true, done: 0, total: r.total, upgraded: 0 }); toast(`Finding exact eligibility URLs for ${r.total} courses…`, "info"); }
    else toast("Every course already has an exact URL.", "info");
  };

  const decide = async (linkId: string, status: string) => {
    await api.post(`/coverage/${linkId}/status`, { status });
    toast(`Marked ${status.replace("_", " ").toLowerCase()}.`, "success");
    await load();
  };
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await load(); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Monitor · Completion"
        title="Coverage"
        subtitle={<>Every official course is mapped to an eligibility source or flagged for review — so nothing is missed silently. A university is <b>COMPLETE</b> only when its review queue is empty.</>}
        actions={
          <>
          {ai?.running ? (
            <span className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
              <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-brand-500" />
              AI reviewing {ai.done}/{ai.total} · {ai.mapped} mapped
            </span>
          ) : (
            <Button variant="secondary" disabled={busy || predict?.running || search?.running || review.total === 0} onClick={aiReview}>AI auto-review</Button>
          )}
          {predict?.running ? (
            <span className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">Predicting {predict.done}/{predict.total} · {predict.mapped} found</span>
          ) : (
            <Button variant="secondary" disabled={busy || ai?.running || search?.running || review.total === 0} onClick={predictUrls}>Predict URLs</Button>
          )}
          {search?.running ? (
            <span className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
              <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-brand-500" />
              Searching {search.engine} {search.done}/{search.total} · {search.mapped} found
            </span>
          ) : (
            <Button variant="secondary" disabled={busy || ai?.running || predict?.running || review.total === 0} onClick={searchFallback}>Web search (free)</Button>
          )}
          {resolve?.running ? (
            <span className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
              <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-brand-500" />
              Exact URLs {resolve.done}/{resolve.total} · {resolve.upgraded} upgraded
            </span>
          ) : (
            <Button variant="secondary" disabled={busy || ai?.running || predict?.running || search?.running} onClick={resolveExact}>Get exact URLs</Button>
          )}
          <Button variant="secondary" disabled={busy || ai?.running || predict?.running || search?.running || review.total === 0} onClick={() => run("auto", async () => { const r = await api.post<{ resolved: number }>("/coverage/auto-resolve"); toast(`Auto-mapped ${r.resolved} to the shared admissions page.`, "success"); })}>Auto-resolve</Button>
          <Button disabled={busy || ai?.running || predict?.running || search?.running} onClick={() => run("export", async () => { const r = await api.post<{ courses: number }>("/coverage/export"); toast(`Exported ${r.courses} course rows → coverage-FINAL.csv`, "success"); })}>Export course coverage</Button>
          </>
        }
      />

      {/* Totals */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCard label="Official courses" value={totals ? totals.total : "—"} />
        <StatCard label="Found (on course)" value={totals ? totals.found : "—"} accent="text-emerald-600" />
        <StatCard label="Shared page" value={totals ? totals.shared : "—"} accent="text-brand-600" />
        <StatCard label="Needs review" value={totals ? totals.needsReview : "—"} accent="text-amber-600" />
        <StatCard label="Not found" value={totals ? totals.notFound : "—"} accent="text-rose-600" />
      </div>

      {/* Per-university completion report */}
      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700">Completion report</div>
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-5 py-3">University</th><th className="px-5 py-3">Courses</th><th className="px-5 py-3">Found</th><th className="px-5 py-3">Shared</th><th className="px-5 py-3">Review</th><th className="px-5 py-3">Not found</th><th className="px-5 py-3">Status</th></tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 4 }).map((_, i) => (
              <tr key={i} className="border-b border-slate-100"><td className="px-5 py-3" colSpan={7}><Skeleton className="h-4 w-full" /></td></tr>
            ))}
            {!loading && unis.length === 0 && (
              <tr><td colSpan={7} className="p-0"><EmptyState title="No coverage data yet" hint="Add universities and run a crawl. Coverage is computed from the discovered course pages." /></td></tr>
            )}
            {!loading && unis.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                <td className="px-5 py-3"><div className="font-medium text-slate-800">{u.name}</div><div className="text-xs text-slate-400">{u.country}</div></td>
                <td className="px-5 py-3 text-slate-600">{u.total}</td>
                <td className="px-5 py-3 text-emerald-600">{u.found}</td>
                <td className="px-5 py-3 text-brand-600">{u.shared}</td>
                <td className="px-5 py-3 text-amber-600">{u.needsReview}</td>
                <td className="px-5 py-3 text-rose-600">{u.notFound}</td>
                <td className="px-5 py-3"><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLS[u.status]}`}>{u.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Review queue */}
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="font-semibold text-slate-900">Review queue <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">{review.total}</span></div>
        </div>
        {review.items.length === 0 ? (
          <div className="py-6 text-center text-sm text-slate-500">Nothing to review — every course is mapped. 🎉</div>
        ) : (
          <div className="space-y-3">
            {review.items.map((r) => (
              <div key={r.linkId} className="rounded-xl border border-slate-200 p-4 dark:border-white/10">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-slate-800">{r.courseName}</div>
                    <div className="text-xs text-slate-400">{r.university}</div>
                  </div>
                  <div className="flex gap-1.5">
                    <Button variant="secondary" onClick={() => decide(r.linkId, "FOUND")}>Found (on course)</Button>
                    <Button variant="secondary" onClick={() => decide(r.linkId, "SHARED")}>Shared page</Button>
                    <Button variant="ghost" onClick={() => decide(r.linkId, "NOT_FOUND")}>Not found</Button>
                  </div>
                </div>
                <div className="mt-2 text-xs text-slate-500">Suggested eligibility URLs:</div>
                <ul className="mt-1 space-y-0.5">
                  {r.suggested.map((s) => (
                    <li key={s}><a href={s} target="_blank" rel="noreferrer" className="break-all text-xs text-brand-600 hover:underline">{s}</a></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      <p className="text-xs text-slate-400">
        Exported file: <a href={`${API_URL}/artifacts/exports/coverage-FINAL.csv`} className="text-brand-600 hover:underline" download>coverage-FINAL.csv</a> — columns: university_name, course_name, course_url, eligibility_url, eligibility_type, status, confidence, evidence_text, last_checked.
      </p>
    </div>
  );
}
