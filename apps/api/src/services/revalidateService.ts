import { logger } from "@clg/shared";
import { getStatus, runExportUniversity, runExportCourses, runExportByUniversity } from "./opsService.js";
import { exportScholarships } from "./scholarshipService.js";
import { getCrawlSettings } from "./crawlAdminService.js";

/**
 * REVALIDATE ORCHESTRATOR — the second pipeline step, in one click.
 *
 * After the single-pass crawl-&-validate has extracted all links, this does the
 * fast finishing pass over the whole set:
 *   university recheck → course recheck  (reachability re-check, GLOBAL de-dup,
 *   drop 404s)  → scholarship export (separate files)
 *
 * It REUSES the existing tracked recheck/export subprocesses (opsService runs one
 * at a time); this just sequences them and exposes a small live state the
 * Revalidate page polls. Content is NOT re-verified here — that already happened
 * inline during the crawl — so this stage is intentionally lean and quick.
 */
type StageKey = "university" | "course" | "scholarship" | "split";
type StageStatus = "pending" | "running" | "done" | "skipped" | "error";
interface Stage { key: StageKey; label: string; status: StageStatus; detail: string }
interface RevalidateState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  stages: Stage[];
  error: string | null;
}

const STAGE_LABELS: Record<StageKey, string> = {
  university: "Re-check + de-dup UNIVERSITY links (drop 404s)",
  course: "Re-check + de-dup COURSE links (drop 404s)",
  scholarship: "Export SCHOLARSHIP links (separate files)",
  split: "Write per-university + combined files (timestamped)",
};

let state: RevalidateState = { running: false, startedAt: null, finishedAt: null, stages: [], error: null };

export const getRevalidate = (): RevalidateState => state;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setStage(key: StageKey, status: StageStatus, detail = "") {
  const s = state.stages.find((x) => x.key === key);
  if (s) { s.status = status; if (detail) s.detail = detail; }
}
function tick(key: StageKey, detail: string) {
  const s = state.stages.find((x) => x.key === key);
  if (s && s.status === "running") s.detail = detail;
}

/** Launch a tracked recheck/export subprocess and wait for it to finish. */
async function runOpsAndWait(launch: () => unknown, onTick: (d: string) => void) {
  launch(); // spawns the child + sets opsService "running"
  await sleep(1500);
  while (state.running) {
    const s = getStatus();
    if (!s.running) {
      const last = s.recent[0];
      if (last && last.status === "error") throw new Error(`${last.label} failed (exit ${last.exitCode ?? "?"})`);
      return;
    }
    onTick(`${s.running.label}${s.running.progress ? ` · ${s.running.progress.percent}%` : ""}`);
    await sleep(2500);
  }
}

const stopped = () => !state.running;

/** Kick off the revalidate pass (no-op if already running). */
export function runRevalidate(): RevalidateState {
  if (state.running) return state;
  const target = getCrawlSettings().CRAWL_TARGET;
  const keys: StageKey[] = ["university", "course", "scholarship", "split"];
  state = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    stages: keys.map((key) => ({ key, label: STAGE_LABELS[key], status: "pending", detail: "" })),
  };

  void (async () => {
    try {
      // Eligibility recheck (skip if scholarship-only) — university then course.
      if (target !== "scholarship") {
        setStage("university", "running", "re-validating university links…");
        await runOpsAndWait(runExportUniversity, (d) => tick("university", d));
        if (stopped()) return;
        setStage("university", "done", "university file written");

        setStage("course", "running", "re-validating course links…");
        await runOpsAndWait(runExportCourses, (d) => tick("course", d));
        if (stopped()) return;
        setStage("course", "done", "course file written");
      } else {
        setStage("university", "skipped", "target = scholarship only");
        setStage("course", "skipped", "target = scholarship only");
      }

      // Scholarship export (skip if eligibility-only) — separate files.
      if (target !== "eligibility") {
        setStage("scholarship", "running", "scanning for scholarship URLs…");
        const r = await exportScholarships();
        setStage("scholarship", "done", `${r.total} URLs (${r.universityUrls} uni · ${r.courseUrls} course)`);
      } else setStage("scholarship", "skipped", "target = eligibility only");

      // Split into SEPARATE per-university files + one combined ALL workbook
      // (needs the eligibility FINAL files written above).
      if (target !== "scholarship") {
        if (stopped()) return;
        setStage("split", "running", "writing per-university files…");
        await runOpsAndWait(runExportByUniversity, (d) => tick("split", d));
        if (stopped()) return;
        setStage("split", "done", "per-university + combined files written");
      } else setStage("split", "skipped", "no eligibility files to split");
    } catch (err) {
      state.error = String(err instanceof Error ? err.message : err);
      const cur = state.stages.find((s) => s.status === "running");
      if (cur) { cur.status = "error"; cur.detail = state.error; }
      logger.error({ err: state.error }, "revalidate failed");
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  })();

  return state;
}

/** Stop advancing (the in-flight subprocess finishes; nothing new starts). */
export function stopRevalidate(): RevalidateState {
  if (state.running) {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    const cur = state.stages.find((s) => s.status === "running");
    if (cur) cur.detail = `${cur.detail} (stopped)`;
  }
  return state;
}
