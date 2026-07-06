"use client";

import { useCallback, useState } from "react";
import { api } from "../lib/api";
import { Card, Button } from "./ui";
import { useAutoRefresh } from "../lib/useAutoRefresh";
import { useToast } from "./Toast";

interface Stage { key: string; label: string; status: "pending" | "running" | "done" | "skipped" | "error"; detail: string }
interface Pipeline { running: boolean; startedAt: string | null; finishedAt: string | null; target: string; stages: Stage[]; error: string | null }

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

export function PipelineRunner() {
  const toast = useToast();
  const [p, setP] = useState<Pipeline | null>(null);

  const load = useCallback(async () => {
    try { setP(await api.get<Pipeline>("/ops/pipeline")); } catch { /* api down */ }
  }, []);
  useAutoRefresh(load, 2500);

  const run = async () => {
    try { await api.post("/ops/pipeline/run"); toast("Full pipeline started — crawl → validate/export → coverage.", "info"); await load(); }
    catch (e) { toast(String(e), "error"); }
  };
  const stop = async () => {
    try { await api.post("/ops/pipeline/stop"); toast("Pipeline will stop after the current stage.", "info"); await load(); }
    catch (e) { toast(String(e), "error"); }
  };

  const running = p?.running ?? false;
  const done = p && !p.running && p.stages.some((s) => s.status === "done");

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold text-slate-900">
            <span className={`h-2.5 w-2.5 flex-none rounded-full ${running ? "animate-pulse bg-brand-500" : done ? "bg-emerald-500" : "bg-slate-300 dark:bg-white/20"}`} />
            Run full pipeline
          </div>
          <div className="mt-0.5 text-sm text-slate-500">
            One click: <b>crawl all → validate &amp; export → reconcile coverage</b>. Follows your <a href="/crawl" className="text-brand-600 hover:underline">crawl target</a>
            {p ? <> (<b>{p.target}</b>)</> : null}. Eligibility &amp; scholarship export to separate files.
          </div>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="danger" onClick={stop}>Stop</Button>
          ) : (
            <Button onClick={run}>{done ? "Run again" : "Run everything"}</Button>
          )}
        </div>
      </div>

      {p && p.stages.length > 0 && (
        <ol className="mt-4 space-y-2">
          {p.stages.map((s, i) => (
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

      {p?.error && <div className="mt-3 rounded-lg border border-rose-100 bg-rose-50 p-2.5 text-sm text-rose-700 dark:bg-rose-500/10">{p.error}</div>}
      {done && !p?.error && <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50 p-2.5 text-sm text-emerald-700 dark:bg-emerald-500/10">Pipeline complete — download from <a href="/exports" className="underline">Download files</a>.</div>}
    </Card>
  );
}
