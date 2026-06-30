import type { FastifyInstance } from "fastify";
import { readdirSync, statSync, existsSync } from "node:fs";
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
import { startCrawlAll, resumeCrawlAll, drainCrawlQueue } from "../services/crawlService.js";
import { getStorageUsage, cleanupArtifacts, clearCrawlData, type StorageTarget } from "../services/storageService.js";
import { runPipeline, getPipeline, stopPipeline } from "../services/pipelineService.js";
import { runRevalidate, getRevalidate, stopRevalidate } from "../services/revalidateService.js";

/** Pipeline control endpoints used by the web "Operations" + "Crawl" pages. */
export async function opsRoutes(app: FastifyInstance) {
  // --- Crawl admin: browser count + page/depth/delay settings, live progress ---
  app.get("/ops/crawl-settings", async () => getCrawlSettings());
  app.put("/ops/crawl-settings", async (req) => updateCrawlSettings((req.body ?? {}) as Parameters<typeof updateCrawlSettings>[0]));
  app.get("/ops/crawl-progress", async () => getCrawlProgress());
  app.get("/ops/system", async () => getSystemInfo());
  app.get("/ops/export-counts", async () => getExportCounts());
  app.post("/ops/crawl/start-all", async () => startCrawlAll());
  app.post("/ops/crawl/resume-all", async () => resumeCrawlAll());
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

  app.post("/ops/aliff", async (req) => {
    const b = (req.body ?? {}) as Partial<AliffOpts>;
    const proc = b.process === "courses" || b.process === "both" ? b.process : "universities";
    if (!b.email || !b.password) {
      throw new HttpError(400, "Aliff email and password are required (used only for this run, never stored).");
    }
    return runAliff({
      process: proc,
      dryRun: b.dryRun !== false, // default DRY-RUN (safe)
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
    add("storage/exports", "/artifacts/exports/", "Validated eligibility URLs", /^eligibility-.*INTERNATIONAL-FINAL\.(xlsx|csv)$/);
    add("storage/exports", "/artifacts/exports/", "Complete export (all universities)", /^eligibility-ALL-INTERNATIONAL_.*\.(xlsx|csv)$/);
    add("storage/exports/by-university", "/artifacts/exports/by-university/", "Per-university files", /\.(xlsx|csv)$/);
    add("storage/exports", "/artifacts/exports/", "Scholarship URLs", /^scholarships-INTERNATIONAL-FINAL\.(xlsx|csv)$/);
    add("tools/aliff-automation/data", "/aliff-data/", "Aliff input files", /aliff-input-.*\.(xlsx|csv)$/);
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { files };
  });
}
