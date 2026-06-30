"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { Card, Button, Badge, StatCard, ProgressBar } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { Reveal, Stagger, Item } from "../../components/motion";
import { useToast } from "../../components/Toast";
import { PipelineStepper, NextStep } from "../../components/PipelineStepper";

interface Stage { key: string; label: string; status: "pending" | "running" | "done" | "skipped" | "error"; detail: string }
interface RevalidateState { running: boolean; startedAt: string | null; finishedAt: string | null; stages: Stage[]; error: string | null }
interface TaskSummary {
  status: "running" | "success" | "error";
  label: string;
  progress: { done: number; total: number; percent: number } | null;
  etaHuman: string | null;
  log: string[];
}
interface OpsStatus { running: TaskSummary | null; recent: TaskSummary[] }
interface Counts { universityUrls: number; courseUrls: number; totalUrls: number }

const DOT: Record<Stage["status"], string> = {
  pending: "bg-slate-300 dark:bg-white/20",
  running: "bg-brand-500",
  done: "bg-emerald-500",
  skipped: "bg-slate-300 dark:bg-white/15",
  error: "bg-rose-500",
};
const TXT: Record<Stage["status"], string> = {
  pending: "text-slate-400",
  running: "text-brand-700 dark:text-brand-200 font-medium",
  done: "text-slate-700 dark:text-slate-200",
  skipped: "text-slate-400 line-through",
  error: "text-rose-600",
};

export default function RevalidatePage() {
  const [state, setState] = useState<RevalidateState | null>(null);
  const [ops, setOps] = useState<OpsStatus>({ running: null, recent: [] });
  const [counts, setCounts] = useState<Counts | null>(null);
  const [scholarship, setScholarship] = useState<Counts | null>(null);
  const [msg, setMsg] = useState("");
  const toast = useToast();
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.get<RevalidateState>("/ops/revalidate"));
      setOps(await api.get<OpsStatus>("/ops/status"));
      setCounts(await api.get<Counts>("/ops/export-counts"));
      setScholarship(await api.get<Counts>("/ops/scholarship-counts"));
    } catch {
      /* api may be down between polls */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [ops]);

  const running = state?.running ?? false;
  const done = state && !state.running && state.stages.some((s) => s.status === "done");
  const live = ops.running ?? ops.recent[0] ?? null;

  const run = async () => {
    setMsg("");
    try {
      await api.post("/ops/revalidate/run");
      toast("Revalidate started — de-duping and dropping any 404s.", "info");
      await refresh();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    }
  };
  const stop = async () => {
    try {
      await api.post("/ops/revalidate/stop");
      toast("Revalidate will stop after the current step.", "info");
      await refresh();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Step 3 · Finishing pass"
        title="Revalidate"
        subtitle={<>After the single-pass crawl has extracted every link, this fast pass <b>removes duplicates</b> and <b>drops any 404 / broken links</b>, then writes the FINAL Excel/CSV. Content was already verified inline during the crawl, so this stage stays quick. Then go to <a href="/export" className="text-brand-600 hover:underline">Export &amp; Aliff</a>.</>}
      />

      <Reveal><PipelineStepper current={3} /></Reveal>

      {msg && <Reveal><Card className="border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{msg}</Card></Reveal>}

      {/* Runner */}
      <Reveal>
        <Card spotlight gradientRing className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-semibold text-slate-900">
                <span className="relative flex h-2.5 w-2.5">
                  {running && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />}
                  <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${running ? "bg-brand-500" : done ? "bg-emerald-500" : "bg-slate-300 dark:bg-white/20"}`} />
                </span>
                Revalidate everything
              </div>
              <div className="mt-0.5 text-sm text-slate-500">Re-checks reachability, de-duplicates globally, removes 404s, and writes the validated files (eligibility + scholarship, separate).</div>
            </div>
            <div className="flex items-center gap-2">
              {running ? (
                <Button variant="danger" onClick={stop}>Stop</Button>
              ) : (
                <Button onClick={run}>{done ? "Revalidate again" : "Revalidate everything"}</Button>
              )}
            </div>
          </div>

          {state && state.stages.length > 0 && (
            <ol className="mt-4 space-y-2">
              {state.stages.map((s, i) => (
                <li key={s.key} className="flex items-start gap-3">
                  <span className="mt-1 flex-none">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white ${DOT[s.status]}`}>
                      {s.status === "done" ? "✓" : s.status === "error" ? "!" : s.status === "skipped" ? "–" : i + 1}
                    </span>
                  </span>
                  <div className="min-w-0">
                    <div className={`text-sm ${TXT[s.status]}`}>{s.label}</div>
                    {s.detail && <div className="truncate text-[11px] text-slate-400">{s.detail}</div>}
                  </div>
                </li>
              ))}
            </ol>
          )}

          {state?.error && <div className="mt-3 rounded-lg border border-rose-100 bg-rose-50 p-2.5 text-sm text-rose-700 dark:bg-rose-500/10">{state.error}</div>}
          {done && !state?.error && <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50 p-2.5 text-sm text-emerald-700 dark:bg-emerald-500/10">Revalidate complete — continue to <a href="/export" className="underline">Export &amp; Aliff</a>, or download from <a href="/exports" className="underline">Download files</a>.</div>}
        </Card>
      </Reveal>

      {/* Counts */}
      <Stagger className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Item><StatCard label="University URLs" value={counts ? counts.universityUrls.toLocaleString() : "—"} accent="text-brand-600" /></Item>
        <Item><StatCard label="Course URLs" value={counts ? counts.courseUrls.toLocaleString() : "—"} accent="text-brand-600" /></Item>
        <Item><StatCard label="Total eligibility" value={counts ? counts.totalUrls.toLocaleString() : "—"} accent="text-emerald-600" /></Item>
        <Item><StatCard label="Scholarship URLs" value={scholarship ? scholarship.totalUrls.toLocaleString() : "—"} accent="text-accent-600" /></Item>
      </Stagger>

      {/* Live log */}
      <Reveal>
        <Card className="p-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900">
              <span className="relative flex h-2 w-2">
                {live?.status === "running" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${live?.status === "running" ? "bg-brand-500" : live?.status === "error" ? "bg-rose-500" : "bg-emerald-500"}`} />
              </span>
              Live activity
            </div>
            {live && (
              <span className="flex items-center gap-2 text-sm">
                {live.status === "running" && live.progress && (
                  <span className="tnum font-medium text-brand-700">{live.progress.percent}% ({live.progress.done}/{live.progress.total}){live.etaHuman ? ` · ETA ${live.etaHuman}` : ""}</span>
                )}
                <Badge value={live.status === "running" ? "VALIDATING" : live.status === "success" ? "COMPLETED" : "FAILED"} />
                <span className="text-slate-600">{live.label}</span>
              </span>
            )}
          </div>
          {live?.status === "running" && live.progress && <div className="mb-3"><ProgressBar percent={live.progress.percent} /></div>}
          <div className="overflow-hidden rounded-xl border border-slate-800/60 bg-slate-950 shadow-inner dark:border-white/10">
            <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
              <span className="ml-2 font-mono text-[11px] text-slate-400">revalidate — live log</span>
            </div>
            <pre ref={logRef} className="h-64 overflow-auto p-3 font-mono text-xs leading-relaxed text-emerald-100/90">
              {live ? live.log.join("\n") : "No runs yet. Click “Revalidate everything”."}
            </pre>
          </div>
        </Card>
      </Reveal>

      <Reveal><NextStep href="/export" label="Export & Aliff — build inputs, push, download" hint="Validated files are ready — build the Aliff inputs and push them in." /></Reveal>
    </div>
  );
}
