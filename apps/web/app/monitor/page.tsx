"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Card, Button, StatCard, EmptyState } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { Reveal, Stagger, Item } from "../../components/motion";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { useToast } from "../../components/Toast";

interface Change { url: string; type: "NEW" | "CHANGED" | "BROKEN" | "FIXED"; university: string; kind: string; at: string; note: string }
interface Summary {
  lastRun: string | null; tracked: number; ok: number; broken: number;
  recent: Change[]; sinceLastRun: { NEW: number; CHANGED: number; BROKEN: number; FIXED: number };
}
interface Progress { running: boolean; done: number; total: number; changed: number; broken: number; newly: number; fixed: number }

const TYPE: Record<Change["type"], { label: string; cls: string }> = {
  NEW: { label: "New", cls: "bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300" },
  CHANGED: { label: "Changed", cls: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" },
  BROKEN: { label: "Broken", cls: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300" },
  FIXED: { label: "Fixed", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" },
};

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function MonitorPage() {
  const toast = useToast();
  const [sum, setSum] = useState<Summary | null>(null);
  const [prog, setProg] = useState<Progress | null>(null);

  const load = useCallback(async () => {
    try { setSum(await api.get<Summary>("/monitor/summary")); } catch { /* api down */ }
  }, []);
  useAutoRefresh(load, 6000);

  useEffect(() => {
    if (!prog?.running) return;
    const t = setInterval(async () => {
      const p = await api.get<Progress>("/monitor/progress");
      setProg(p);
      if (!p.running) { clearInterval(t); toast(`Check complete — ${p.changed} changed, ${p.broken} broken, ${p.newly} new.`, "success"); await load(); }
    }, 1500);
    return () => clearInterval(t);
  }, [prog?.running, load, toast]);

  const runCheck = async () => {
    const r = await api.post<{ started: boolean; total: number }>("/monitor/run");
    if (r.started) { setProg({ running: true, done: 0, total: r.total, changed: 0, broken: 0, newly: 0, fixed: 0 }); toast(`Re-checking ${r.total} URLs for changes…`, "info"); }
    else if (r.total === 0) toast("No exported URLs to monitor yet — run an export first.", "info");
  };

  const since = sum?.sinceLastRun;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Monitor · Freshness"
        title="Change Monitor"
        subtitle={<>Keeps your exported eligibility &amp; scholarship URLs <b>current</b>. Re-checks every link and flags what <b>changed</b>, <b>broke</b>, came back, or is <b>new</b> — so your CRM never goes stale. Run on a schedule (e.g. weekly).</>}
        actions={
          prog?.running ? (
            <span className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
              <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" /></span>
              Checking {prog.done}/{prog.total} · {prog.changed} changed · {prog.broken} broken
            </span>
          ) : (
            <Button onClick={runCheck}>Run check now</Button>
          )
        }
      />

      <Stagger className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Item><StatCard label="URLs tracked" value={sum ? sum.tracked : "—"} /></Item>
        <Item><StatCard label="Working" value={sum ? sum.ok : "—"} accent="text-emerald-600" /></Item>
        <Item><StatCard label="Broken" value={sum ? sum.broken : "—"} accent="text-rose-600" /></Item>
        <Item><StatCard label="Changed (last run)" value={since ? since.CHANGED : "—"} accent="text-amber-600" /></Item>
        <Item><StatCard label="New (last run)" value={since ? since.NEW : "—"} accent="text-brand-600" /></Item>
      </Stagger>

      <p className="-mt-2 text-xs text-slate-400">Last check: {ago(sum?.lastRun ?? null)}{sum?.lastRun ? ` (${new Date(sum.lastRun).toLocaleString()})` : ""}. Tip: schedule this weekly so requirement updates, expired scholarships and broken links are caught automatically.</p>

      <Reveal>
        <Card className="p-5">
          <div className="mb-3 font-semibold text-slate-900">Recent changes</div>
          {!sum || sum.recent.length === 0 ? (
            <EmptyState title="No changes recorded yet" hint="Run a check to establish a baseline; on the next check you'll see exactly what changed, broke, or is new." />
          ) : (
            <div className="space-y-2">
              {sum.recent.map((c, i) => (
                <div key={`${c.url}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-100 p-3 dark:border-white/10">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${TYPE[c.type].cls}`}>{TYPE[c.type].label}</span>
                  <span className="text-xs uppercase tracking-wide text-slate-400">{c.kind}</span>
                  <span className="font-medium text-slate-800">{c.university || "—"}</span>
                  <span className="ml-auto text-xs text-slate-400">{ago(c.at)}</span>
                  <div className="w-full">
                    <a href={c.url} target="_blank" rel="noreferrer" className="break-all text-xs text-brand-600 hover:underline">{c.url}</a>
                    <div className="text-xs text-slate-500">{c.note}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Reveal>
    </div>
  );
}
