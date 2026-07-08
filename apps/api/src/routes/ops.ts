import type { FastifyInstance } from "fastify";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { repoRoot, DEFAULT_KEYWORDS, loadCustomKeywords, saveCustomKeywords, type KeywordSets } from "@clg/shared";
import { HttpError } from "../lib/http.js";
import {
  runExportUniversity,
  runExportCourses,
  runExportByUniversity,
  runTransform,
  runAliff,
  getStatus,
  aliffInputsStatus,
  type AliffOpts,
} from "../services/opsService.js";
import { getCrawlSettings, updateCrawlSettings, getCrawlProgress, getExportCounts, clearLogs, resetAllData, getSystemInfo, recomputeStats } from "../services/crawlAdminService.js";
import { backupData, listBackups, restoreData } from "../services/backupService.js";
import { exportScholarships, scholarshipCounts } from "../services/scholarshipService.js";
import { getSettings, updateSettings } from "../services/settingsService.js";
import { getCrawlerState, startCrawler, stopCrawler, restartCrawler } from "../services/crawlerControlService.js";
import { startCrawlAll, resumeCrawlAll, drainCrawlQueue, recoverCrawl } from "../services/crawlService.js";
import { getAutoRecoverInfo } from "../services/crawlStallWatchdog.js";
import { getStorageUsage, cleanupArtifacts, clearCrawlData, type StorageTarget } from "../services/storageService.js";
import { runPipeline, getPipeline, stopPipeline } from "../services/pipelineService.js";
import { runRevalidate, getRevalidate, stopRevalidate } from "../services/revalidateService.js";
import { requireRole } from "../plugins/auth.js";

/** Pipeline control endpoints used by the web "Operations" + "Crawl" pages. */
export async function opsRoutes(app: FastifyInstance) {
  // --- Crawl admin: browser count + page/depth/delay settings, live progress ---
  app.get("/ops/crawl-settings", async () => getCrawlSettings());
  app.put("/ops/crawl-settings", async (req) => updateCrawlSettings((req.body ?? {}) as Parameters<typeof updateCrawlSettings>[0]));
  // Live progress, with the self-heal watchdog's recent activity attached so the
  // stall card can show "auto-recovering…" / "auto-recovery paused".
  app.get("/ops/crawl-progress", async () => ({ ...(await getCrawlProgress()), autoRecover: getAutoRecoverInfo() }));
  app.get("/ops/system", async () => getSystemInfo());
  app.get("/ops/export-counts", async () => getExportCounts());
  app.post("/ops/crawl/start-all", async () => startCrawlAll());
  app.post("/ops/crawl/resume-all", async () => resumeCrawlAll());
  // One-click recovery for a stalled crawl: ensure the engine is running + re-queue
  // every incomplete university so a lost/failed job is recreated and it continues.
  app.post("/ops/crawl/recover", async () => recoverCrawl());
  app.post("/ops/crawl/drain", async () => drainCrawlQueue());

  // --- Full pipeline: one click runs crawl → export → coverage end to end ---
  app.post("/ops/pipeline/run", async () => runPipeline());
  app.get("/ops/pipeline", async () => getPipeline());
  app.post("/ops/pipeline/stop", async () => stopPipeline());

  // --- Revalidate step (step 3): re-check + global de-dup + drop 404s, fast ---
  app.post("/ops/revalidate/run", async () => runRevalidate());
  app.get("/ops/revalidate", async () => getRevalidate());
  app.post("/ops/revalidate/stop", async () => stopRevalidate());

  // --- Crawler worker process control (Start / Stop / Restart in one click) ---
  app.get("/ops/crawler", async () => getCrawlerState());
  app.post("/ops/crawler/start", async () => startCrawler());
  app.post("/ops/crawler/stop", async () => stopCrawler());
  app.post("/ops/crawler/restart", async () => restartCrawler());

  // --- Maintenance: clear logs / full reset (destructive — UI confirms first) ---
  app.post("/ops/maintenance/clear-logs", async () => clearLogs());
  app.post("/ops/maintenance/reset-all", async () => resetAllData());
  app.post("/ops/maintenance/recount", async () => recomputeStats());

  // --- Storage: disk usage + reclaim space after export (delete images/cache) ---
  app.get("/ops/storage", async () => getStorageUsage());
  app.post("/ops/storage/cleanup", async (req) =>
    cleanupArtifacts(((req.body as { targets?: StorageTarget[] } | undefined)?.targets ?? [])),
  );
  app.post("/ops/storage/clear-crawl-data", async () => clearCrawlData());

  // --- Backup / Restore (the curated university list + decisions) ---
  app.post("/ops/backup", async () => backupData("manual"));
  app.get("/ops/backups", async () => listBackups());
  app.post("/ops/restore", async (req) => restoreData((req.body as { file?: string } | undefined)?.file));

  // --- All settings (every hyperparameter), with notes, editable from the UI ---
  app.get("/ops/settings", async () => getSettings());
  app.put("/ops/settings", async (req) => updateSettings((req.body ?? {}) as Record<string, unknown>));

  // --- Editable keyword vocabulary (eligibility / international / evidence) ---
  app.get("/ops/keywords", async () => ({ defaults: DEFAULT_KEYWORDS, custom: loadCustomKeywords() }));
  app.put("/ops/keywords", async (req) => {
    saveCustomKeywords((req.body ?? {}) as Partial<KeywordSets>);
    return { defaults: DEFAULT_KEYWORDS, custom: loadCustomKeywords() };
  });

  app.post("/ops/export/university", async () => runExportUniversity());
  app.post("/ops/export/courses", async () => runExportCourses());
  // Split the validated files into SEPARATE per-university files (+ combined ALL).
  app.post("/ops/export/by-university", async () => runExportByUniversity());
  app.post("/ops/transform", async () => runTransform());

  // --- Scholarship module (separate operation, separate Excel) ---
  app.post("/ops/export/scholarships", async () => exportScholarships());
  app.get("/ops/scholarship-counts", async () => scholarshipCounts());

  // --- Latest validation audits (dataset hash + diff), per level -----------------
  // Written by recheck.ts after every run (storage/audits/recheck-<level>-<run>.json).
  // The Revalidate page shows these as the run's proof: what shipped, what changed,
  // and the determinism hash (same site + same config ⇒ same hash).
  app.get("/ops/audits/latest", async () => {
    const dir = resolve(repoRoot(), "storage", "audits");
    const out: Record<string, unknown> = {};
    if (!existsSync(dir)) return { audits: out };
    for (const level of ["university", "course"]) {
      const files = readdirSync(dir)
        .filter((f) => f.startsWith(`recheck-${level}-`) && f.endsWith(".json"))
        .sort(); // run_id is an ISO timestamp → lexicographic sort = chronological
      const latest = files[files.length - 1];
      if (!latest) continue;
      try {
        out[level] = JSON.parse(readFileSync(join(dir, latest), "utf8"));
      } catch { /* unreadable audit — skip */ }
    }
    return { audits: out };
  });

  app.post("/ops/aliff", async (req) => {
    const b = (req.body ?? {}) as Partial<AliffOpts>;
    const proc = b.process === "courses" || b.process === "both" ? b.process : "universities";
    if (!b.email || !b.password) {
      throw new HttpError(400, "Aliff email and password are required (used only for this run, never stored).");
    }
    const dryRun = b.dryRun !== false; // default DRY-RUN (safe)
    // LIVE pushes to the Aliff CRM are ADMIN-only; DRY-RUN is fine for OPERATOR+
    // (the centralized role gate already requires OPERATOR minimum for this POST).
    if (!dryRun) requireRole(req, "ADMIN");
    return runAliff({
      process: proc,
      dryRun,
      overwrite: b.overwrite === true, // default off
      limit: Number(b.limit) || 0,
      headless: b.headless !== false, // default headless
      email: String(b.email),
      password: String(b.password),
    });
  });

  app.get("/ops/status", async () => getStatus());

  // Which Aliff input files are built — lets the UI guide the user before a run.
  app.get("/ops/aliff-ready", async () => aliffInputsStatus());

  // List the deliverable files (validated exports + Aliff inputs) with download URLs.
  // `mtime` (ms) lets the UI show "last exported" in the user's local time.
  app.get("/ops/files", async () => {
    const files: { name: string; size: number; url: string; group: string; mtime: number }[] = [];
    const add = (dirRel: string, urlPrefix: string, group: string, match: RegExp) => {
      const dir = resolve(repoRoot(), dirRel);
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) {
        if (!match.test(f)) continue;
        const st = statSync(join(dir, f));
        files.push({ name: f, size: st.size, url: `${urlPrefix}${encodeURIComponent(f)}`, group, mtime: st.mtimeMs });
      }
    };
    add("storage/exports", "/files/", "Validated eligibility URLs", /^eligibility-.*INTERNATIONAL-FINAL\.(xlsx|csv)$/);
    add("storage/exports", "/files/", "Complete export (all universities)", /^eligibility-ALL-INTERNATIONAL_.*\.(xlsx|csv)$/);
    add("storage/exports/by-university", "/files/by-university/", "Per-university files", /\.(xlsx|csv)$/);
    add("storage/exports", "/files/", "Scholarship URLs", /^scholarships-INTERNATIONAL-FINAL\.(xlsx|csv)$/);
    add("tools/aliff-automation/data", "/aliff-data/", "Aliff input files", /aliff-input-.*\.(xlsx|csv)$/);
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { files };
  });
}
