"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, API_URL, ApiError } from "../../lib/api";
import { Card, Button, Badge, ProgressBar } from "../../components/ui";
import { ConfirmButton } from "../../components/Confirm";
import { PageHeader } from "../../components/PageHeader";
import { Reveal } from "../../components/motion";
import { useToast } from "../../components/Toast";
import { PipelineStepper } from "../../components/PipelineStepper";

interface TaskSummary {
  id: string;
  label: string;
  status: "running" | "success" | "error";
  progress: { done: number; total: number; percent: number } | null;
  etaHuman: string | null;
  log: string[];
}
interface OpsStatus { running: TaskSummary | null; recent: TaskSummary[] }
interface FileRow { name: string; size: number; url: string; group: string; mtime: number }
interface Counts { universityUrls: number; courseUrls: number; totalUrls: number }

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
const fieldCls = "w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5";

function StepBadge({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 font-semibold text-slate-900">
      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white">{n}</span>
      {children}
    </div>
  );
}

export default function ExportPage() {
  const [status, setStatus] = useState<OpsStatus>({ running: null, recent: [] });
  const [files, setFiles] = useState<FileRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [scholarship, setScholarship] = useState<Counts | null>(null);
  const [aliffReady, setAliffReady] = useState<{ universities: boolean; courses: boolean } | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [busyBtn, setBusyBtn] = useState<string>("");
  const toast = useToast();
  const logRef = useRef<HTMLPreElement>(null);

  // Aliff form
  const [proc, setProc] = useState<"universities" | "courses" | "both">("universities");
  const [dryRun, setDryRun] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [limit, setLimit] = useState(5);
  const [headless, setHeadless] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.get<OpsStatus>("/ops/status"));
      setFiles((await api.get<{ files: FileRow[] }>("/ops/files")).files);
      setCounts(await api.get("/ops/export-counts"));
      setScholarship(await api.get("/ops/scholarship-counts"));
      setAliffReady(await api.get("/ops/aliff-ready"));
    } catch {
      /* API may be down between polls */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setMsg("");
    setBusyBtn(label);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusyBtn("");
    }
  };

  const busy = !!status.running || !!busyBtn;
  const live = status.running ?? status.recent[0] ?? null;

  // Group the deliverable files by section; show the newest export time in the
  // user's LOCAL timezone (toLocaleString uses the browser's local time).
  const groups = [...new Set(files.map((f) => f.group))];
  const lastExported = files.length
    ? new Date(Math.max(...files.map((f) => f.mtime || 0))).toLocaleString()
    : null;

  const inputsReady =
    aliffReady === null
      ? null
      : proc === "universities"
        ? aliffReady.universities
        : proc === "courses"
          ? aliffReady.courses
          : aliffReady.universities && aliffReady.courses;
  const aliffDisabled = busy || !email || !password || inputsReady === false;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Step 4 · Export & Aliff"
        title="Export & Aliff"
        subtitle={<>The validated files are produced in <a href="/revalidate" className="text-brand-600 hover:underline">Revalidate</a>. Here you build the Aliff input files, push them into the Aliff CRM with your login, and download the deliverables. Start with a DRY-RUN.</>}
      />

      <Reveal><PipelineStepper current={4} /></Reveal>

      {msg && <Reveal><Card className="border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{msg}</Card></Reveal>}

      {/* Scholarship export (separate files) */}
      <Reveal>
        <Card hover className="p-5 border-amber-200/60 dark:border-amber-500/20">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2.5 font-semibold text-slate-900">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-accent-500 text-xs font-bold text-white">★</span>
                Scholarship URLs (separate file)
              </div>
              <div className="mt-1 max-w-2xl text-sm text-slate-500">
                Collects scholarship / funding pages (university &amp; course level) into their own Excel — never mixed with eligibility. Usually already produced by Revalidate; re-run here if needed.
                {scholarship && <span className="ml-1">Last: <b className="text-accent-700 dark:text-accent-300">{scholarship.universityUrls} uni · {scholarship.courseUrls} course · {scholarship.totalUrls} total</b>.</span>}
              </div>
            </div>
            <Button variant="accent" disabled={busy} onClick={() => run("sch", async () => { const r = await api.post<{ total: number }>("/ops/export/scholarships"); toast(`Exported ${r.total} scholarship URLs → scholarships-INTERNATIONAL-FINAL.xlsx`, "success"); })}>
              Export scholarship URLs
            </Button>
          </div>
        </Card>
      </Reveal>

      {/* Per-university / complete split export */}
      <Reveal>
        <Card hover className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2.5 font-semibold text-slate-900">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-emerald-600 text-xs font-bold text-white">⤓</span>
                Separate per-university files (+ complete export)
              </div>
              <div className="mt-1 max-w-2xl text-sm text-slate-500">
                Splits the validated URLs into a <b>separate CSV + Excel for each university</b> (under <code>by-university/</code>) <i>and</i> one <b>complete</b> all-in-one workbook — every file stamped with the export time (your local time). Runs automatically as part of <a href="/revalidate" className="text-brand-600 hover:underline">Revalidate</a>; click here to refresh on demand.
              </div>
            </div>
            <Button variant="secondary" disabled={busy} onClick={() => run("byuni", async () => { await api.post("/ops/export/by-university"); toast("Writing per-university + complete files…", "info"); })}>
              Export per-university files
            </Button>
          </div>
        </Card>
      </Reveal>

      {/* Build Aliff inputs */}
      <Reveal>
        <Card hover className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <StepBadge n={1}>Build Aliff input files</StepBadge>
              <div className="mt-1 text-sm text-slate-500">Transforms the validated exports into the Aliff format (universities + courses, kept separate).</div>
            </div>
            <Button disabled={busy} onClick={() => run("xf", () => api.post("/ops/transform"))}>Build inputs</Button>
          </div>
        </Card>
      </Reveal>

      {/* Aliff auto-fill */}
      <Reveal>
        <Card className="p-5">
          <StepBadge n={2}>Aliff auto-fill (login)</StepBadge>
          <div className="mt-1 text-sm text-slate-500">Logs into Aliff and fills the eligibility links. Start with DRY-RUN (no save) and a small limit. Credentials are used only for this run and never stored.</div>

          {inputsReady === false && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              <svg viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 flex-none" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
              <div>Input files for <b>{proc === "both" ? "universities + courses" : proc}</b> aren&apos;t built yet. Run <b>Revalidate</b> first, then <b>Step 1 (Build inputs)</b> above — then this unlocks.</div>
            </div>
          )}
          {inputsReady === true && (
            <div className="mt-3 flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M20 6 9 17l-5-5" /></svg>
              Input files ready — good to run.
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium text-slate-700">What to process</span>
              <select className={fieldCls} value={proc} onChange={(e) => setProc(e.target.value as typeof proc)}>
                <option value="universities">Universities only</option>
                <option value="courses">Courses only</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-slate-700">Limit (0 = all)</span>
              <input type="number" min={0} className={fieldCls} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-slate-700">Aliff email</span>
              <input type="email" autoComplete="off" className={fieldCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@aliff.in" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-slate-700">Aliff password</span>
              <input type="password" autoComplete="off" className={fieldCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-5 text-sm">
            <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> <span>DRY-RUN (no save)</span></label>
            <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> <span>Overwrite existing values</span></label>
            <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={headless} onChange={(e) => setHeadless(e.target.checked)} /> <span>Headless (hide browser)</span></label>
          </div>
          <div className="mt-4 flex items-center gap-3">
            {dryRun ? (
              <Button variant="primary" disabled={aliffDisabled}
                onClick={() => run("aliff", () => api.post("/ops/aliff", { process: proc, dryRun, overwrite, limit, headless, email, password }))}>
                Run DRY-RUN
              </Button>
            ) : (
              <ConfirmButton
                label="Run LIVE (saves to Aliff)"
                variant="danger"
                disabled={aliffDisabled}
                title="Run LIVE against your Aliff CRM?"
                message={`This will SAVE real records to Aliff — ${proc}, limit ${limit || "all"}${overwrite ? ", overwriting existing values" : ""}. Start small (limit 5) and verify in Aliff. Continue?`}
                confirmLabel="Run LIVE"
                onConfirm={() => run("aliff", () => api.post("/ops/aliff", { process: proc, dryRun, overwrite, limit, headless, email, password }))}
              />
            )}
            {!dryRun && <span className="text-xs font-medium text-rose-600">LIVE writes real records to your Aliff CRM.</span>}
          </div>
        </Card>
      </Reveal>

      {/* Live activity */}
      <Reveal>
        <Card className="p-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900">
              <span className={`h-2 w-2 flex-none rounded-full ${live?.status === "running" ? "animate-pulse bg-brand-500" : live?.status === "error" ? "bg-rose-500" : "bg-emerald-500"}`} />
              Live activity
            </div>
            {live && (
              <span className="flex items-center gap-2 text-sm">
                {live.status === "running" && live.progress && (
                  <span className="tnum font-medium text-brand-700">{live.progress.percent}% ({live.progress.done}/{live.progress.total}){live.etaHuman ? ` · ETA ${live.etaHuman}` : ""}</span>
                )}
                <Badge value={live.status === "running" ? "EXTRACTING" : live.status === "success" ? "COMPLETED" : "FAILED"} />
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
              <span className="ml-2 font-mono text-[11px] text-slate-400">ops — live log</span>
            </div>
            <pre ref={logRef} className="h-64 overflow-auto p-3 font-mono text-xs leading-relaxed text-emerald-100/90">
              {live ? live.log.join("\n") : "No runs yet. Start a step above."}
            </pre>
          </div>
        </Card>
      </Reveal>

      {/* Files */}
      <Reveal>
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold text-slate-900">Deliverable files</div>
            <div className="flex flex-col items-end gap-0.5 text-sm text-slate-600">
              {counts && (
                <div>
                  Extracted URLs — <b className="text-brand-700">University {counts.universityUrls.toLocaleString()}</b> · <b className="text-brand-700">Course {counts.courseUrls.toLocaleString()}</b> · <b className="text-emerald-700">Total {counts.totalUrls.toLocaleString()}</b>
                </div>
              )}
              {lastExported && <div className="text-xs text-slate-400">Last exported: <b>{lastExported}</b> (your local time)</div>}
            </div>
          </div>
          {files.length === 0 ? (
            <div className="text-sm text-slate-500">No files yet — run <a href="/revalidate" className="text-brand-600 hover:underline">Revalidate</a>, then Build inputs.</div>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => {
                const inGroup = files.filter((f) => f.group === g);
                return (
                  <div key={g}>
                    <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <span className="h-1 w-1 rounded-full bg-brand-500" />{g}
                      <span className="tnum rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-white/10">{inGroup.length}</span>
                    </div>
                    <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                      {inGroup.map((f) => (
                        <div key={f.name} className="flex items-center justify-between rounded-lg border-b border-slate-100 px-2 py-2 text-sm transition-colors hover:bg-slate-50/60 dark:border-white/5 dark:hover:bg-white/5">
                          <div className="min-w-0">
                            <a className="break-all font-medium text-brand-700 hover:underline" href={`${API_URL}${f.url}`} target="_blank" rel="noreferrer">{f.name}</a>
                            <span className="ml-2 text-xs text-slate-400">{kb(f.size)}</span>
                          </div>
                          <a className="flex-none text-xs text-brand-600 hover:underline" href={`${API_URL}${f.url}`} download>Download</a>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </Reveal>
    </div>
  );
}
