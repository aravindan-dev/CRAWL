import { logger } from "@clg/shared";
import { getCrawlQueue, getParseQueue } from "@clg/queue";
import { startCrawler, getCrawlerState } from "./crawlerControlService.js";
import { startCrawlAll } from "./crawlService.js";
import { getStatus, runExportUniversity, runExportCourses } from "./opsService.js";
import { exportScholarships } from "./scholarshipService.js";
import { autoResolve, predictUrls, getPredictProgress, exportCoverage } from "./coverageService.js";
import { getCrawlSettings, getCrawlProgress, type CrawlTarget } from "./crawlAdminService.js";

/**
 * FULL-PIPELINE ORCHESTRATOR — the "complete engine" in one click. Chains the
 * whole flow end to end so the user doesn't drive each page by hand:
 *
 *   engine → crawl all → wait for crawl + parse to drain →
 *   validate & export (eligibility and/or scholarship, per CRAWL_TARGET) →
 *   coverage auto-resolve + predict + export
 *
 * Eligibility and scholarship always go to SEPARATE files. Runs in the
 * background; the dashboard polls getPipeline() for live stage progress.
 */
type StageKey = "engine" | "crawl" | "eligibility" | "scholarship" | "coverage";
type StageStatus = "pending" | "running" | "done" | "skipped" | "error";
interface Stage { key: StageKey; label: string; status: StageStatus; detail: string }
interface PipelineState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  target: CrawlTarget;
  stages: Stage[];
  error: string | null;
}

const STAGE_LABELS: Record<StageKey, string> = {
  engine: "Start engine",
  crawl: "Crawl all universities",
  eligibility: "Validate & export eligibility URLs",
  scholarship: "Export scholarship URLs",
  coverage: "Reconcile coverage (auto-resolve + predict)",
};

let pipeline: PipelineState = { running: false, startedAt: null, finishedAt: null, target: "both", stages: [], error: null };

export const getPipeline = (): PipelineState => pipeline;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setStage(key: StageKey, status: StageStatus, detail = "") {
  const s = pipeline.stages.find((x) => x.key === key);
  if (s) { s.status = status; if (detail) s.detail = detail; }
}
function tick(key: StageKey, detail: string) {
  const s = pipeline.stages.find((x) => x.key === key);
  if (s && s.status === "running") s.detail = detail;
}

/**
 * Wait until the crawl + parse are truly finished. Uses BOTH the BullMQ queue
 * counts AND the live university statuses (activeRemaining) — because during a
 * resumed crawl a job can be executing while briefly absent from the queue's
 * active set, so queue counts alone can read "empty" too early. We require BOTH
 * signals quiet for several consecutive checks before declaring done.
 */
async function waitForDrain(onTick: (d: string) => void) {
  await sleep(4000); // let startCrawlAll's enqueues register first
  let quietStreak = 0;
  const start = Date.now();
  const MAX_MS = 8 * 60 * 60 * 1000; // 8h hard safety net
  while (pipeline.running && Date.now() - start < MAX_MS) {
    const [c, p, prog] = await Promise.all([
      getCrawlQueue().getJobCounts(),
      getParseQueue().getJobCounts(),
      getCrawlProgress().catch(() => ({ activeRemaining: 0 })),
    ]);
    const crawlBusy = (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0);
    const parseBusy = (p.waiting ?? 0) + (p.active ?? 0) + (p.delayed ?? 0);
    const activeUnis = (prog as { activeRemaining?: number }).activeRemaining ?? 0;
    onTick(`crawling ${activeUnis} uni · ${crawlBusy} queued · parsing ${parseBusy}`);
    if (crawlBusy === 0 && parseBusy === 0 && activeUnis === 0) { quietStreak += 1; if (quietStreak >= 4) return; }
    else quietStreak = 0;
    await sleep(4000);
  }
}

/** Launch a tracked export subprocess and wait for it to finish. */
async function runOpsAndWait(launch: () => unknown, onTick: (d: string) => void) {
  launch(); // spawns the child + sets opsService "running"
  await sleep(1500);
  while (pipeline.running) {
    const s = getStatus();
    if (!s.running) {
      const last = s.recent[0];
      if (last && last.status === "error") throw new Error(`${last.label} failed (exit ${last.exitCode ?? "?"})`);
      return;
    }
    onTick(`${s.running.label}${s.running.progress ? ` · ${s.running.progress.percent}%` : ""}`);
    await sleep(3000);
  }
}

/** Kick off the full pipeline (no-op if already running). */
export function runPipeline(): PipelineState {
  if (pipeline.running) return pipeline;
  const target = getCrawlSettings().CRAWL_TARGET;
  const keys: StageKey[] = ["engine", "crawl", "eligibility", "scholarship", "coverage"];
  pipeline = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    target,
    error: null,
    stages: keys.map((key) => ({ key, label: STAGE_LABELS[key], status: "pending", detail: "" })),
  };

  const stopped = () => !pipeline.running; // bail cleanly when the user clicks Stop

  void (async () => {
    try {
      // 1) Engine
      setStage("engine", "running");
      if (!getCrawlerState().running) startCrawler();
      await sleep(2500);
      setStage("engine", "done", getCrawlerState().running ? "engine running" : "engine not detected");

      // 2) Crawl all + wait for crawl & parse to drain
      if (stopped()) return;
      setStage("crawl", "running", "queuing universities…");
      await startCrawlAll();
      await waitForDrain((d) => tick("crawl", d));
      if (stopped()) return;
      setStage("crawl", "done", "crawl + parse complete");

      // 3) Eligibility export (skip if scholarship-only)
      if (target !== "scholarship") {
        if (stopped()) return;
        setStage("eligibility", "running", "validating university links…");
        await runOpsAndWait(runExportUniversity, (d) => tick("eligibility", d));
        if (stopped()) return; // don't launch the next export if stopped mid-way
        tick("eligibility", "validating course links…");
        await runOpsAndWait(runExportCourses, (d) => tick("eligibility", d));
        setStage("eligibility", "done", "university + course files written");
      } else setStage("eligibility", "skipped", "target = scholarship only");

      // 4) Scholarship export (skip if eligibility-only) — separate files
      if (target !== "eligibility") {
        if (stopped()) return;
        setStage("scholarship", "running", "scanning for scholarship URLs…");
        const r = await exportScholarships();
        setStage("scholarship", "done", `${r.total} URLs (${r.universityUrls} uni · ${r.courseUrls} course)`);
      } else setStage("scholarship", "skipped", "target = eligibility only");

      // 5) Coverage reconciliation — auto-resolve + predict + export
      if (stopped()) return;
      setStage("coverage", "running", "auto-resolving…");
      await autoResolve();
      tick("coverage", "predicting eligibility URLs…");
      await predictUrls();
      while (pipeline.running && getPredictProgress().running) {
        const pp = getPredictProgress();
        tick("coverage", `predicting ${pp.done}/${pp.total} · mapped ${pp.mapped}`);
        await sleep(3000);
      }
      await exportCoverage();
      setStage("coverage", "done", "coverage reconciled + exported");
    } catch (err) {
      pipeline.error = String(err instanceof Error ? err.message : err);
      const cur = pipeline.stages.find((s) => s.status === "running");
      if (cur) { cur.status = "error"; cur.detail = pipeline.error; }
      logger.error({ err: pipeline.error }, "pipeline failed");
    } finally {
      pipeline.running = false;
      pipeline.finishedAt = new Date().toISOString();
    }
  })();

  return pipeline;
}

/** Stop advancing the pipeline (in-flight stage finishes; nothing new starts). */
export function stopPipeline(): PipelineState {
  if (pipeline.running) {
    pipeline.running = false;
    pipeline.finishedAt = new Date().toISOString();
    const cur = pipeline.stages.find((s) => s.status === "running");
    if (cur) cur.detail = `${cur.detail} (stopped)`;
  }
  return pipeline;
}
