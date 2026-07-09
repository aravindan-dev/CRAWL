"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { Card, Button, Badge, StatCard, ProgressBar } from "../../components/ui";
import { ConfirmButton } from "../../components/Confirm";
import { PageHeader } from "../../components/PageHeader";
import { Reveal, Stagger, Item } from "../../components/motion";
import { Icons } from "../../components/icons";
import { useToast } from "../../components/Toast";
import { UniversityUrlsDrawer } from "../../components/UniversityUrlsDrawer";
import { ValidatedFeed } from "../../components/ValidatedFeed";
import { PipelineStepper, NextStep } from "../../components/PipelineStepper";

const ACTIVE_STATUSES = ["DISCOVERING", "VALIDATING", "EXTRACTING", "PARSING"];

// Clean, human-readable text for a failed request — uses the API's message and
// drops the noisy "Error:" prefix that String(err) adds.
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type CrawlTarget = "both" | "eligibility" | "scholarship";
interface CrawlSettings {
  CRAWL_CONCURRENCY: number;
  MAX_PAGES_PER_UNIVERSITY: number;
  MAX_CRAWL_DEPTH: number;
  CRAWL_DELAY_MS: number;
  MAX_CRAWL_MINUTES: number;
  CRAWL_TARGET: CrawlTarget;
}
const TARGET_OPTS: { key: CrawlTarget; label: string; note: string }[] = [
  { key: "both", label: "Both", note: "Eligibility + scholarship — exported to separate files" },
  { key: "eligibility", label: "Eligibility / course URLs", note: "Entry-criteria pages only" },
  { key: "scholarship", label: "Scholarship URLs", note: "Funding pages only" },
];
interface Progress {
  total: number;
  completed: number;
  remaining: number;
  activeRemaining: number;
  byStatus: Record<string, number>;
  links: number;
  intlLinks: number;
  snapshots: number;
  pagesCrawled: number;
  pagesPerMin: number | null;
  validatedPerMin: number;
  elapsedSeconds: number | null;
  avgSecondsPerUniversity: number | null;
  phase?: "discovering" | "finishing" | "idle" | "done";
  remainingWork?: number;
  discoveryRatio?: number;
  stalled: boolean;
  lastActivityAt: string | null;
  stalledForSeconds: number | null;
  autoRecover?: { enabled: boolean; recoverCount: number; lastRecoverAt: string | null };
  v4EarlyStops: number;
  v4DeepPasses: number;
  browserFallback: number;
  blockedDomains: number;
  confidenceScore: number;
  memoryUsage: number;
  cpuUsage: number;
  universities: { id: string; name: string; country: string; crawl_status: string }[];
}
interface CrawlerState { running: boolean; pid: number | null }
interface Counts { universityUrls: number; courseUrls: number; totalUrls: number }

export default function CrawlPage() {
  const [settings, setSettings] = useState<CrawlSettings | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [crawler, setCrawler] = useState<CrawlerState>({ running: false, pid: null });
  const [counts, setCounts] = useState<Counts | null>(null);
  const [msg, setMsg] = useState("");
  const [drawerId, setDrawerId] = useState<string | null>(null); // per-university URL drawer
  const toast = useToast();

  const poll = useCallback(async () => {
    try {
      setProgress(await api.get<Progress>("/ops/crawl-progress"));
      setCrawler(await api.get<CrawlerState>("/ops/crawler"));
      setCounts(await api.get<Counts>("/ops/export-counts"));
    } catch {
      /* api may be momentarily down */
    }
  }, []);

  useEffect(() => {
    api.get<CrawlSettings>("/ops/crawl-settings").then(setSettings).catch(() => {});
    poll();
    const t = setInterval(poll, 2500);
    return () => clearInterval(t);
  }, [poll]);

  const setTarget = async (t: CrawlTarget) => {
    if (!settings) return;
    const next = { ...settings, CRAWL_TARGET: t };
    setSettings(next);
    try {
      setSettings(await api.put<CrawlSettings>("/ops/crawl-settings", next));
      const lbl = TARGET_OPTS.find((o) => o.key === t)?.label ?? t;
      setMsg(`Crawl target set to “${lbl}”. Click Restart engine to apply. Eligibility and scholarship always export to separate files.`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    }
  };

  // Every engine/crawl action gives the user clear feedback (success or error).
  const startEngine = () => api.post("/ops/crawler/start").then(() => { toast("Crawl engine started.", "success"); return poll(); }).catch((e) => toast(errText(e), "error"));
  const restartEngine = () => api.post("/ops/crawler/restart").then(() => { toast("Crawl engine restarting — new settings will apply.", "info"); return poll(); }).catch((e) => toast(errText(e), "error"));
  const stopEngine = () => api.post("/ops/crawler/stop").then(() => { toast("Crawl engine stopped.", "info"); return poll(); }).catch((e) => toast(errText(e), "error"));
  const crawlAll = () => api.post<{ started: number; skippedNoUrl: number }>("/ops/crawl/start-all").then((r) => { toast(r.started > 0 ? `Fresh crawl started — previous results cleared. Queued ${r.started} universit${r.started === 1 ? "y" : "ies"}${r.skippedNoUrl ? ` · ${r.skippedNoUrl} skipped (no website)` : ""}. Stats below start from zero and climb live…` : "Nothing to crawl — add a university with a website first.", r.started > 0 ? "success" : "info"); return poll(); }).catch((e) => toast(errText(e), "error"));
  const resumeAll = () => api.post<{ resumed: number; skippedDone: number }>("/ops/crawl/resume-all").then((r) => { toast(r.resumed > 0 ? `Resuming ${r.resumed} universit${r.resumed === 1 ? "y" : "ies"} from where they stopped${r.skippedDone ? ` · ${r.skippedDone} already done` : ""}.` : "Nothing to resume — all universities are done or have no website.", r.resumed > 0 ? "success" : "info"); return poll(); }).catch((e) => toast(errText(e), "error"));
  // One-click recovery for a stalled crawl: ensures the engine is running AND
  // re-queues the stuck universities (a process restart alone can't recover a lost
  // job). This is the correct fix the stall card offers.
  const recoverCrawl = () => api.post<{ engineStarted: boolean; resumed: number }>("/ops/crawl/recover").then((r) => { toast(r.resumed > 0 ? `Recovering — re-queued ${r.resumed} universit${r.resumed === 1 ? "y" : "ies"}${r.engineStarted ? " and started the engine" : ""}. The crawl continues where it left off.` : "Nothing to recover — no incomplete universities.", r.resumed > 0 ? "success" : "info"); return poll(); }).catch((e) => toast(errText(e), "error"));

  const active = progress?.universities.filter((u) => ACTIVE_STATUSES.includes(u.crawl_status)) ?? [];
  // Progress bar reflects universities finished / total — the only figure a crawl
  // actually KNOWS. A crawl can't know how many pages a site has, so there is no
  // page-percentage or time ETA (both would be guesses).
  const pct = progress && progress.total ? (progress.completed / progress.total) * 100 : 0;
  const fmtElapsed = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Step 2 · Crawl & Validate (single pass)"
        title="Crawl & Validate"
        subtitle={<>One process: the engine crawls each URL <b>and validates it inline</b> — confirming the page genuinely is an entry-requirement (eligibility) or scholarship page — then the validated link appears live below, one-by-one. Add universities on the <a href="/universities" className="text-brand-600 hover:underline">Universities</a> page first, then <a href="/revalidate" className="text-brand-600 hover:underline">Revalidate</a> when the crawl finishes.</>}
      />

      <Reveal><PipelineStepper current={2} /></Reveal>

      {msg && <Reveal><Card className="border-brand-100 bg-brand-50 p-3 text-sm text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">{msg}</Card></Reveal>}

      {/* Crawl engine control */}
      <Reveal>
        <Card hover className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-semibold text-slate-900">
                Crawl engine
                <Badge value={crawler.running ? (active.length > 0 ? "DISCOVERING" : "READY") : "STOPPED"} />
              </div>
              <div className="mt-0.5 text-sm text-slate-500">{crawler.running
                ? (active.length > 0
                    ? `Crawling ${active.length} universit${active.length === 1 ? "y" : "ies"} right now (process ${crawler.pid}).`
                    : `Ready — the engine starts automatically with the app and waits for work. It isn't crawling anything yet; click “Crawl all universities” below to begin.`)
                : "Stopped. Start it, then queue a crawl below."}</div>
            </div>
            <div className="flex items-center gap-2">
              {!crawler.running && <Button onClick={startEngine}>Start engine</Button>}
              {crawler.running && (
                <>
                  <ConfirmButton label="Restart engine" variant="secondary" title="Restart the crawl engine?"
                    message="Stops the current engine and starts a fresh one so new settings (browser count, pages, AI) take effect. In-progress page loads are interrupted; queued work resumes."
                    confirmLabel="Restart" onConfirm={restartEngine} />
                  <ConfirmButton label="Stop engine" variant="danger" title="Stop the crawl engine?"
                    message="The engine stops processing. You can start it again anytime; queued universities resume."
                    confirmLabel="Stop" onConfirm={stopEngine} />
                </>
              )}
            </div>
          </div>
        </Card>
      </Reveal>

      {/* Stalled warning — engine "running" but no pages for 10 min (likely crashed
          mid-university and lost the job). The engine self-heals in the background;
          this card explains what's happening and offers the one-click fix. */}
      {crawler.running && progress?.stalled && progress.activeRemaining > 0 && (
        <Reveal>
          <Card className="flex flex-wrap items-center justify-between gap-3 border-amber-300 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
            <div className="flex items-start gap-3">
              <svg viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 flex-none text-amber-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
              <div className="text-sm text-amber-900 dark:text-amber-100">
                <b>Crawl looks stalled.</b> No pages crawled{progress.stalledForSeconds ? ` for ${fmtElapsed(progress.stalledForSeconds)}` : " for a while"}, but {progress.activeRemaining} universit{progress.activeRemaining === 1 ? "y is" : "ies are"} still active — the engine likely crashed (often low memory). <b>Resume</b> re-queues the stuck universit{progress.activeRemaining === 1 ? "y" : "ies"} so it continues where it left off (a plain engine restart can’t recover a lost job).
                {progress.autoRecover && (progress.autoRecover.recoverCount > 0 || !progress.autoRecover.enabled) && (
                  <div className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80">
                    {progress.autoRecover.enabled
                      ? `Auto-recovery is running (attempt ${progress.autoRecover.recoverCount}). If it doesn’t catch, recover manually →`
                      : `Auto-recovery paused after ${progress.autoRecover.recoverCount} tries — likely low memory. Lower the browser count in Settings, then recover manually →`}
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-none items-center gap-2">
              <Button onClick={recoverCrawl}>Resume crawl</Button>
              <ConfirmButton label="Restart engine" variant="secondary" title="Restart the crawl engine?"
                message="Stops the current engine and starts a fresh one (clears a wedged browser pool). Then click Resume to re-queue the stuck universities."
                confirmLabel="Restart" onConfirm={restartEngine} />
            </div>
          </Card>
        </Reveal>
      )}

      {/* What to extract — drives the crawl focus + which export is populated */}
      <Reveal>
        <Card hover className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold text-slate-900">What to extract</div>
              <div className="mt-0.5 text-sm text-slate-500">Choose the crawl focus. <b>Eligibility</b> and <b>scholarship</b> URLs always export to <b>separate</b> Excel/CSV files — never mixed.</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {TARGET_OPTS.map((o) => {
                const activeT = (settings?.CRAWL_TARGET ?? "both") === o.key;
                return (
                  <button key={o.key} type="button" onClick={() => setTarget(o.key)} title={o.note}
                    className={`rounded-xl border px-3.5 py-2 text-left text-sm transition ${activeT ? "border-brand-400 bg-brand-50 text-brand-800 ring-2 ring-brand-400/30 dark:bg-brand-500/15 dark:text-brand-100" : "border-slate-200 bg-white/60 text-slate-600 hover:border-brand-300 dark:border-white/10 dark:bg-white/5"}`}>
                    <span className="block font-semibold">{o.label}</span>
                    <span className="block text-[11px] leading-tight opacity-80">{o.note}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </Card>
      </Reveal>

      {/* Queue a crawl */}
      <Reveal>
        <Card hover className="p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold text-slate-900">Start crawling</div>
              <div className="mt-0.5 text-sm text-slate-500">The engine above must be running. <b>Crawl all</b> starts a <b>fresh</b> crawl — it clears the previous run so the stats below begin at zero and climb live. <b>Resume</b> continues a stopped crawl exactly where it left off (already-crawled pages are skipped).</div>
            </div>
            <div className="flex items-center gap-2">
              {/* recoverCrawl (not resumeAll) so this works even when the engine
                  is stopped/crashed — it starts the engine AND re-queues
                  incomplete universities in one click, instead of forcing the
                  user to click "Start engine" first just to unlock Resume. */}
              <Button variant="secondary" onClick={recoverCrawl}>Resume crawl</Button>
              <ConfirmButton label="Crawl all universities" variant="primary" disabled={!crawler.running}
                title="Start a fresh crawl?"
                message="This clears the previous run's results (links, pages, statuses) and crawls every university from scratch, so the live stats start from zero. Your universities and their websites are kept (and backed up first). To continue the previous crawl instead, use Resume."
                confirmLabel="Start fresh crawl" onConfirm={crawlAll} />
            </div>
          </div>
        </Card>
      </Reveal>

      {/* Live crawl monitor — real-time progress + currently-crawling universities */}
      <Reveal>
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-slate-900">
              <span className={`h-2.5 w-2.5 flex-none rounded-full ${crawler.running ? "animate-pulse bg-brand-500" : "bg-slate-300 dark:bg-white/20"}`} />
              Live crawl monitor
            </div>
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <Icons.pulse size={14} className={crawler.running ? "text-brand-500" : "text-slate-400"} />
              {crawler.running ? "Engine running" : "Engine idle"}
            </span>
          </div>

          <div className="mt-4">
            <ProgressBar percent={pct} label={progress ? `${progress.completed} of ${progress.total} universities complete${progress.activeRemaining > 0 ? ` · ${progress.activeRemaining} crawling now` : ""}` : "Waiting for data…"} />
            {progress && crawler.running && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1 font-medium text-brand-600">
                  <Icons.pulse size={12} /> {progress.phase === "discovering" ? "Discovering pages…" : "Crawling…"}
                </span>
                {progress.pagesPerMin ? (
                  <span title="Every page fetch — discovery/nav pages included, not just validated targets">
                    ⚡ {progress.pagesPerMin} pages/min
                    {" · "}
                    <span className={progress.validatedPerMin > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400"}>
                      {progress.validatedPerMin > 0 ? progress.validatedPerMin : 0} validated/min
                    </span>
                  </span>
                ) : null}
                {progress.elapsedSeconds ? <span>elapsed {fmtElapsed(progress.elapsedSeconds)}</span> : null}
                {progress.lastActivityAt ? <span className={progress.stalled ? "text-amber-600 dark:text-amber-400" : ""}>last page {fmtElapsed(Math.max(0, Math.round((Date.now() - new Date(progress.lastActivityAt).getTime()) / 1000)))} ago</span> : null}
                <span>{progress.activeRemaining} in this crawl</span>
                <span>{progress.links.toLocaleString()} links · {progress.intlLinks.toLocaleString()} international</span>
              </div>
            )}
          </div>

          {progress && (
            <div className="mt-6 mb-2 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-5 shadow-inner border border-white/10 dark:from-slate-900/60 dark:to-black/40">
              <div className="col-span-full mb-1 flex items-center justify-between">
                <div className="text-xs font-semibold tracking-wider text-slate-400 uppercase">V4 Engine Intelligence</div>
                <div className="flex items-center gap-1.5 rounded-full bg-brand-500/20 px-2 py-0.5 text-[10px] font-medium text-brand-300 ring-1 ring-inset ring-brand-500/30">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75"></span>
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-500"></span>
                  </span>
                  V4 ACTIVE
                </div>
              </div>
              <div className="flex flex-col gap-1 rounded-xl bg-white/5 p-3 ring-1 ring-white/10 transition-colors hover:bg-white/10">
                <div className="text-[10px] font-medium text-slate-400">Confidence</div>
                <div className="flex items-baseline gap-1">
                  <span className="text-xl font-light tabular-nums text-white">{progress.confidenceScore}</span>
                  <span className="text-xs text-brand-400">%</span>
                </div>
              </div>
              <div className="flex flex-col gap-1 rounded-xl bg-white/5 p-3 ring-1 ring-white/10 transition-colors hover:bg-white/10">
                <div className="text-[10px] font-medium text-slate-400">Early Stops</div>
                <div className="text-xl font-light tabular-nums text-white">{progress.v4EarlyStops}</div>
              </div>
              <div className="flex flex-col gap-1 rounded-xl bg-white/5 p-3 ring-1 ring-white/10 transition-colors hover:bg-white/10">
                <div className="text-[10px] font-medium text-slate-400">Deep Passes</div>
                <div className="text-xl font-light tabular-nums text-white">{progress.v4DeepPasses}</div>
              </div>
              <div className="flex flex-col gap-1 rounded-xl bg-amber-500/10 p-3 ring-1 ring-amber-500/20 transition-colors hover:bg-amber-500/15">
                <div className="text-[10px] font-medium text-amber-500/80">Browser Fallback</div>
                <div className="text-xl font-light tabular-nums text-amber-400">{progress.browserFallback}</div>
              </div>
              <div className="flex flex-col gap-1 rounded-xl bg-rose-500/10 p-3 ring-1 ring-rose-500/20 transition-colors hover:bg-rose-500/15">
                <div className="text-[10px] font-medium text-rose-500/80">Blocked Domains</div>
                <div className="text-xl font-light tabular-nums text-rose-400">{progress.blockedDomains}</div>
              </div>
              <div className="flex flex-col gap-1 rounded-xl bg-white/5 p-3 ring-1 ring-white/10 transition-colors hover:bg-white/10">
                <div className="flex justify-between items-center text-[10px] font-medium text-slate-400">
                  <span>System</span>
                  <span>{progress.cpuUsage}% CPU</span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div className="h-full bg-brand-400 transition-all duration-500" style={{ width: `${progress.memoryUsage}%` }} />
                </div>
                <div className="mt-0.5 text-right text-[9px] text-slate-500">{progress.memoryUsage}% RAM</div>
              </div>
            </div>
          )}

          <div className="mt-4">
            <div className="eyebrow mb-2"><span className="h-1 w-1 rounded-full bg-brand-500" />Currently crawling{active.length > 0 ? ` · ${active.length}` : ""}</div>
            {active.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400 dark:border-white/10">
                {crawler.running ? "No active jobs right now — queue a crawl above." : "Engine is stopped — start it to see live activity."}
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {active.map((u) => (
                  <button key={u.name} onClick={() => setDrawerId(u.id)} title="Click to see this university's verified URLs"
                    className="relative w-full rounded-xl border border-brand-200/60 bg-brand-50/40 p-3 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/70 dark:border-brand-500/20 dark:bg-brand-500/10">
                    <div className="relative flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Icons.crawl size={15} className="flex-none text-brand-500" />
                        <span className="truncate text-sm font-medium text-slate-800">{u.name}</span>
                      </div>
                      <Badge value={u.crawl_status} />
                    </div>
                    <div className="relative mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                      <Icons.globe size={12} /> {u.country} · <span className="text-brand-600">view URLs →</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {progress && (
            <div className="mt-4 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3 dark:border-white/5">
              {Object.entries(progress.byStatus).map(([s, n]) => (
                <span key={s} className="flex items-center gap-1 text-xs"><Badge value={s} /><span className="tnum text-slate-500">{n}</span></span>
              ))}
            </div>
          )}
        </Card>
      </Reveal>

      {/* Live validated-URLs feed — the single-pass payoff: validated links stream
          in here one-by-one as each page is crawled & confirmed. */}
      <Reveal><ValidatedFeed /></Reveal>

      {/* Crawl-engine tuning (browsers, time budget, depth…) now lives on the
          Settings page — link here so it's still one click away. */}
      <Reveal>
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="text-sm text-slate-500">
            <span className="font-semibold text-slate-700">Crawl settings</span> (browsers, time budget, depth, pages) moved to the Settings page.
          </div>
          <a href="/settings" className="text-sm font-medium text-brand-600 hover:underline">Open crawl settings →</a>
        </Card>
      </Reveal>

      {/* Progress */}
      <Stagger className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Item><StatCard label="Completed" value={progress ? `${progress.completed}/${progress.total}` : "—"} accent="text-emerald-600" /></Item>
        <Item><StatCard label="Pages / min" value={progress?.pagesPerMin ? progress.pagesPerMin.toLocaleString() : "—"} accent="text-brand-600" /></Item>
        <Item><StatCard label="Links found" value={progress ? progress.links.toLocaleString() : "—"} /></Item>
        <Item><StatCard label="Pages crawled" value={progress ? progress.pagesCrawled.toLocaleString() : "—"} /></Item>
      </Stagger>
      {progress?.avgSecondsPerUniversity ? (
        <p className="-mt-2 text-xs text-slate-400">Avg {progress.avgSecondsPerUniversity}s per university · {progress.remaining} remaining · International candidates {progress.intlLinks.toLocaleString()}</p>
      ) : null}

      {/* Exported deliverable totals */}
      <Reveal>
        <Card className="p-5">
          <div className="mb-3 text-sm font-semibold text-slate-700">Extracted eligibility / criteria URLs (last export)</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="University URLs" value={counts ? counts.universityUrls.toLocaleString() : "—"} accent="text-brand-600" />
            <StatCard label="Course URLs" value={counts ? counts.courseUrls.toLocaleString() : "—"} accent="text-brand-600" />
            <StatCard label="Total URLs" value={counts ? counts.totalUrls.toLocaleString() : "—"} accent="text-emerald-600" />
          </div>
          <p className="mt-2 text-xs text-slate-400">These come from the validated exports (run <a href="/revalidate" className="text-brand-600 hover:underline">Revalidate</a> to refresh).</p>
        </Card>
      </Reveal>

      <Reveal>
        <Card className="overflow-hidden p-5">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-semibold text-slate-900">Per-university progress</div>
            <div className="flex flex-wrap gap-1.5">
              {progress && Object.entries(progress.byStatus).map(([s, n]) => (
                <span key={s} className="flex items-center gap-1 text-xs"><Badge value={s} /> <span className="text-slate-500">{n}</span></span>
              ))}
            </div>
          </div>
          <div className="max-h-80 overflow-auto rounded-xl border border-slate-100 dark:border-white/10">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-ink-850">
                <tr><th className="px-3 py-2.5">University</th><th className="px-3 py-2.5">Country</th><th className="px-3 py-2.5">Status</th></tr>
              </thead>
              <tbody>
                {progress?.universities.map((u) => (
                  <tr key={u.name} onClick={() => setDrawerId(u.id)} title="Click to see this university's verified URLs"
                    className="cursor-pointer border-t border-slate-100 transition-colors hover:bg-slate-50/60 dark:border-white/5 dark:hover:bg-white/5">
                    <td className="px-3 py-2 font-medium text-slate-700 hover:text-brand-600">{u.name}</td>
                    <td className="px-3 py-2 text-slate-500">{u.country}</td>
                    <td className="px-3 py-2"><Badge value={u.crawl_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </Reveal>

      <Reveal><NextStep href="/revalidate" label="Revalidate — de-dup & drop 404s" hint="Run this once the crawl has finished to clean and write the final files." /></Reveal>

      <UniversityUrlsDrawer universityId={drawerId} onClose={() => setDrawerId(null)} />
    </div>
  );
}
