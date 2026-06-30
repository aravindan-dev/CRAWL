import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import os from "node:os";
import { repoRoot } from "@clg/shared";
import { prisma, universityRepository } from "@clg/database";
import { backupData } from "./backupService.js";

/** Detected machine resources — used by the dashboard's RAM-based auto-tune. */
export function getSystemInfo() {
  return {
    ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    cores: os.cpus().length,
  };
}

/**
 * Crawl settings + live progress for the dashboard's Crawl page.
 * Settings are persisted to the repo .env so the crawler worker picks them up on
 * its next (re)start (BullMQ worker concurrency is fixed at process start).
 */
const ENV_PATH = resolve(repoRoot(), ".env");

const DEFAULTS = {
  CRAWL_CONCURRENCY: 3, // "browsers" = universities crawled in parallel
  MAX_PAGES_PER_UNIVERSITY: 300,
  MAX_CRAWL_DEPTH: 4,
  CRAWL_DELAY_MS: 1500,
  MAX_CRAWL_MINUTES: 40, // hard time budget per university (0 = no limit)
} as const;
type Key = keyof typeof DEFAULTS;
const LIMITS: Record<Key, [number, number]> = {
  CRAWL_CONCURRENCY: [1, 12], // up to 12 parallel browsers (high-end CPU + 32GB RAM)
  MAX_PAGES_PER_UNIVERSITY: [10, 50000], // match the full Settings cap (thorough crawls)
  MAX_CRAWL_DEPTH: [1, 12],
  CRAWL_DELAY_MS: [0, 10000],
  MAX_CRAWL_MINUTES: [0, 240], // 0 = unlimited; up to 4h for exhaustive single runs
};

function parseEnvFile(): Record<string, string> {
  const map: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return map;
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) map[m[1]!] = m[2]!;
  }
  return map;
}

const TARGETS = ["both", "eligibility", "scholarship"] as const;
export type CrawlTarget = (typeof TARGETS)[number];
const DEFAULT_TARGET: CrawlTarget = "both";
export type CrawlSettings = Record<Key, number> & { CRAWL_TARGET: CrawlTarget };

export function getCrawlSettings(): CrawlSettings {
  const e = parseEnvFile();
  const out = {} as Record<Key, number>;
  for (const k of Object.keys(DEFAULTS) as Key[]) out[k] = Number(e[k] ?? DEFAULTS[k]);
  const t = (e.CRAWL_TARGET ?? DEFAULT_TARGET) as CrawlTarget;
  return { ...out, CRAWL_TARGET: TARGETS.includes(t) ? t : DEFAULT_TARGET };
}

export function updateCrawlSettings(input: Partial<Record<Key, number>> & { CRAWL_TARGET?: string }): CrawlSettings {
  const apply: Record<string, string> = {};
  for (const k of Object.keys(DEFAULTS) as Key[]) {
    const raw = input[k];
    if (raw === undefined || raw === null || !Number.isFinite(Number(raw))) continue;
    const [lo, hi] = LIMITS[k];
    apply[k] = String(Math.max(lo, Math.min(hi, Math.round(Number(raw)))));
  }
  // CRAWL_TARGET is a string enum, validated + written alongside the numeric settings.
  if (typeof input.CRAWL_TARGET === "string" && (TARGETS as readonly string[]).includes(input.CRAWL_TARGET)) {
    apply.CRAWL_TARGET = input.CRAWL_TARGET;
  }
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && apply[m[1]!] !== undefined) {
      seen.add(m[1]!);
      return `${m[1]}=${apply[m[1]!]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(apply)) if (!seen.has(k)) next.push(`${k}=${v}`);
  writeFileSync(ENV_PATH, next.join("\n"), "utf8");
  return getCrawlSettings();
}

const INTL_SQL =
  "lower(coalesce(final_url,url)) ~ 'international[-_]?student|/international/|country[-_]?or[-_]?territory|english[-_]?language|ielts|toefl|/visa|entry[-_]?requirement'";

/** Count rows in the validated export CSVs — the actual DELIVERABLE URL totals. */
function countCsvRows(path: string): number {
  if (!existsSync(path)) return 0;
  const txt = readFileSync(path, "utf8").trim();
  if (!txt) return 0;
  return Math.max(0, txt.split(/\r?\n/).filter((l) => l.trim()).length - 1); // minus header
}

const COURSES_CSV = "eligibility-COURSES-INTERNATIONAL-FINAL.csv";
const UNIVERSITY_CSV = "eligibility-UNIVERSITY-INTERNATIONAL-FINAL.csv";
const exportsDir = () => resolve(repoRoot(), "storage", "exports");

export function getExportCounts() {
  const dir = exportsDir();
  const uPath = join(dir, UNIVERSITY_CSV);
  const cPath = join(dir, COURSES_CSV);
  const universityUrls = countCsvRows(uPath);
  const courseUrls = countCsvRows(cPath);
  const at = (p: string) => (existsSync(p) ? statSync(p).mtime.toISOString() : null);
  return {
    universityUrls,
    courseUrls,
    totalUrls: universityUrls + courseUrls,
    generatedAt: at(cPath) ?? at(uPath),
  };
}

// --- Per-university VERIFIED deliverable data (from the validated export files) -
// The live DB counters (total_courses_extracted / total_valid_links) reflect only
// the AI-PARSED subset of pages, so they badly undercount the real deliverable.
// The authoritative, browser-revalidated, de-duplicated rows are in the FINAL
// export CSVs — we read them per university so every screen shows the SAME verified
// numbers AND the exact URLs that ship (used by the per-university URL drawer).

export interface VerifiedUrlRow {
  level: "university" | "course";
  course_name: string;
  url: string;
  http_status: string;
  validity: string;
}
export interface VerifiedCounts {
  courseUrls: number;
  universityUrls: number;
  validUrls: number;
}

/** Normalize a university name for matching DB rows to export rows. */
const normUniName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Parse CSV text into rows of fields (handles quoted commas/quotes/newlines). */
function parseCsv(txt: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (txt[i + 1] === '"') { field += '"'; i++; } // escaped "" → "
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Read a FINAL export CSV into verified rows grouped by normalized university name. */
function readDeliverable(path: string): Map<string, VerifiedUrlRow[]> {
  const m = new Map<string, VerifiedUrlRow[]>();
  if (!existsSync(path)) return m;
  const txt = readFileSync(path, "utf8").replace(/^﻿/, "");
  const rows = parseCsv(txt);
  // header: university,country,level,course_name,eligibility_url,http_status,validity
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const name = normUniName(r[0] ?? "");
    if (!name) continue;
    const list = m.get(name) ?? m.set(name, []).get(name)!;
    list.push({
      level: r[2] === "university" ? "university" : "course",
      course_name: r[3] ?? "",
      url: r[4] ?? "",
      http_status: r[5] ?? "",
      validity: r[6] ?? "",
    });
  }
  return m;
}

let deliverableCache: { key: string; map: Map<string, VerifiedUrlRow[]> } | null = null;

/** All verified deliverable rows per university, cached by export-file mtime. */
function getVerifiedRowsByUniversity(): Map<string, VerifiedUrlRow[]> {
  const dir = exportsDir();
  const cPath = join(dir, COURSES_CSV);
  const uPath = join(dir, UNIVERSITY_CSV);
  const mt = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  const key = `${mt(cPath)}:${mt(uPath)}`;
  if (deliverableCache && deliverableCache.key === key) return deliverableCache.map;

  const map = new Map<string, VerifiedUrlRow[]>();
  for (const src of [readDeliverable(cPath), readDeliverable(uPath)]) {
    for (const [name, rows] of src) {
      const list = map.get(name) ?? map.set(name, []).get(name)!;
      list.push(...rows);
    }
  }
  // University-level links first, then courses A→Z — a stable, readable order.
  for (const list of map.values()) {
    list.sort((a, b) =>
      a.level === b.level ? a.course_name.localeCompare(b.course_name) : a.level === "university" ? -1 : 1,
    );
  }
  deliverableCache = { key, map };
  return map;
}

/** Verified deliverable rows for one university (empty until it has been exported). */
export function getVerifiedRowsFor(name: string): VerifiedUrlRow[] {
  return getVerifiedRowsByUniversity().get(normUniName(name)) ?? [];
}

/** Verified counts for one university (null if it has no rows in the export yet). */
export function verifiedCountsFor(name: string): VerifiedCounts | null {
  const rows = getVerifiedRowsByUniversity().get(normUniName(name));
  if (!rows || rows.length === 0) return null;
  let courseUrls = 0;
  let universityUrls = 0;
  for (const r of rows) r.level === "course" ? (courseUrls += 1) : (universityUrls += 1);
  return { courseUrls, universityUrls, validUrls: courseUrls + universityUrls };
}

/** Clear the crawl activity log only. */
export async function clearLogs() {
  const { count } = await prisma.crawlLog.deleteMany({});
  return { deletedLogs: count };
}

/**
 * Recompute every university's headline counters from the real tables, fixing any
 * drift from older per-event increments (e.g. valid > links). Returns the
 * corrected per-university numbers.
 */
export async function recomputeStats() {
  await universityRepository.recomputeAllStats();
  const unis = await prisma.university.findMany({
    orderBy: { name: "asc" },
    select: { name: true, total_links_found: true, total_valid_links: true, total_courses_extracted: true },
  });
  return { updated: unis.length, universities: unis };
}

/**
 * Wipe the previous run's crawl artifacts but KEEP the universities (and their
 * websites), then reset every university to IDLE with zeroed counters. This is
 * what makes "Crawl all universities" a genuinely FRESH crawl — links, pages and
 * completed counts all start from zero and climb live — as opposed to "Resume",
 * which keeps the data and continues exactly where it left off.
 */
export async function resetCrawlArtifacts() {
  // Safety net: snapshot the university list first, so the wipe is recoverable.
  try { await backupData("auto-before-fresh-crawl"); } catch { /* best-effort */ }
  const courseCriteria = (await prisma.courseCriteria.deleteMany({})).count;
  const pageSnapshot = (await prisma.pageSnapshot.deleteMany({})).count;
  const discoveredLink = (await prisma.discoveredLink.deleteMany({})).count;
  const crawlLog = (await prisma.crawlLog.deleteMany({})).count;
  const crawlJob = (await prisma.crawlJob.deleteMany({})).count;
  // Keep the university rows; just reset their crawl state + headline counters.
  await prisma.university.updateMany({
    data: { crawl_status: "IDLE", total_links_found: 0, total_valid_links: 0, total_courses_extracted: 0 },
  });
  return { discoveredLink, pageSnapshot, courseCriteria, crawlLog, crawlJob };
}

/** Full reset: delete ALL universities and every piece of crawl data. */
export async function resetAllData() {
  // Safety net: always snapshot the university list first, so even a full wipe
  // is one click away from being restored.
  try { await backupData("auto-before-reset"); } catch { /* best-effort */ }
  const courseCriteria = (await prisma.courseCriteria.deleteMany({})).count;
  const pageSnapshot = (await prisma.pageSnapshot.deleteMany({})).count;
  const discoveredLink = (await prisma.discoveredLink.deleteMany({})).count;
  const crawlLog = (await prisma.crawlLog.deleteMany({})).count;
  const crawlJob = (await prisma.crawlJob.deleteMany({})).count;
  const universities = (await prisma.university.deleteMany({})).count;
  return { universities, discoveredLink, pageSnapshot, courseCriteria, crawlLog, crawlJob };
}

/** Human-friendly duration, e.g. 95 -> "1m 35s", 5400 -> "1h 30m". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec}s`;
}

export async function getCrawlProgress() {
  const unis = await prisma.university.findMany({
    select: { id: true, name: true, country: true, crawl_status: true },
    orderBy: [{ sort_order: "asc" }, { created_at: "asc" }], // reflect the manual crawl order
  });
  const byStatus: Record<string, number> = {};
  for (const u of unis) byStatus[u.crawl_status] = (byStatus[u.crawl_status] ?? 0) + 1;

  const agg = await prisma.$queryRawUnsafe<{ links: number; intl: number; snaps: number; visited: number }[]>(
    `SELECT (SELECT count(*) FROM discovered_link)::int AS links,
            (SELECT count(*) FROM discovered_link WHERE ${INTL_SQL})::int AS intl,
            (SELECT count(*) FROM page_snapshot)::int AS snaps,
            (SELECT count(*) FROM discovered_link WHERE http_status IS NOT NULL)::int AS visited`,
  );
  const a = agg[0] ?? { links: 0, intl: 0, snaps: 0, visited: 0 };

  const completed = byStatus["COMPLETED"] ?? 0;
  const discovering = byStatus["DISCOVERING"] ?? 0;
  const queued = byStatus["QUEUED"] ?? 0;
  const remaining = unis.length - completed;
  // Universities left to finish in the CURRENT crawl (not idle ones that were
  // never started). ETA is for this active batch.
  const activeRemaining = discovering + queued;
  const crawling = activeRemaining > 0;

  const settings = getCrawlSettings();
  const maxPages = settings.MAX_PAGES_PER_UNIVERSITY || 300;
  const browsers = settings.CRAWL_CONCURRENCY || 1;

  // --- LIVE ETA -------------------------------------------------------------
  // We measure real wall-clock throughput of the current run and project the
  // remaining work — so an estimate appears within seconds, before any single
  // university has fully finished.
  //
  //   effectiveDone = (universities completed this run)
  //                 + Σ fractional progress of the in-progress universities
  //   fraction(u)   = min(0.95, pagesCrawled(u) / expectedPages)
  //   rate          = effectiveDone / elapsed         (universities per second;
  //                                                     parallelism is baked in)
  //   ETA           = (batchTotal - effectiveDone) / rate
  //
  // IMPORTANT: the fraction denominator is the REALISTIC expected page count
  // (the average of universities already completed), NOT the 5000-page hard cap
  // — most sites finish well before the cap, so using the cap made every site
  // look ~4% done and inflated/grew the ETA.
  // "Pages crawled" = pages actually VISITED (http_status recorded), not the
  // smaller subset that produced a snapshot — and certainly not the sitemap URLs
  // that are merely DISCOVERED. avg_pages = realistic per-university visited count.
  const run = await prisma.$queryRawUnsafe<{ elapsed: number | null; completed_run: number; avg_secs: number | null; avg_pages: number | null }[]>(
    `SELECT EXTRACT(EPOCH FROM (now() - min(j.started_at)))::float AS elapsed,
            count(*) FILTER (WHERE j.status = 'COMPLETED')::int     AS completed_run,
            EXTRACT(EPOCH FROM avg(j.finished_at - j.started_at) FILTER (WHERE j.status = 'COMPLETED'))::float AS avg_secs,
            (SELECT avg(c)::float FROM (
               SELECT count(dl.id) AS c FROM university u
               JOIN discovered_link dl ON dl.university_id = u.id AND dl.http_status IS NOT NULL
               WHERE u.crawl_status = 'COMPLETED' GROUP BY u.id
             ) t)                                                    AS avg_pages
       FROM crawl_job j
      WHERE j.started_at IS NOT NULL AND j.started_at > now() - interval '12 hours'`,
  );
  const elapsed = run[0]?.elapsed ?? null;
  const completedRun = run[0]?.completed_run ?? 0;
  const avgSecs = run[0]?.avg_secs ?? null;
  // Realistic per-university page expectation, clamped to a sane range.
  const expectedPages = Math.max(80, Math.min(maxPages, Math.round(run[0]?.avg_pages ?? 250)));

  // Fractional progress of the in-progress universities, by VISITED pages.
  const inProg = await prisma.$queryRawUnsafe<{ visited: number }[]>(
    `SELECT count(dl.id)::int AS visited
       FROM university u JOIN discovered_link dl ON dl.university_id = u.id AND dl.http_status IS NOT NULL
      WHERE u.crawl_status = 'DISCOVERING'
      GROUP BY u.id`,
  );
  const visitedInProgress = inProg.reduce((s, r) => s + (r.visited || 0), 0);
  const fractionsSum = inProg.reduce((s, r) => s + Math.min(0.95, (r.visited || 0) / expectedPages), 0);

  const effectiveDone = completedRun + fractionsSum;
  const batchTotal = completedRun + activeRemaining;

  // RECENT throughput (last 10 min) — the ONLY reliable speed signal. Using
  // wall-clock since the first job is wrong: across restarts/idle/crash gaps it
  // inflates "elapsed" → a tiny rate → an absurd multi-hour ETA. Recent pages/min
  // reflects the crawl's CURRENT speed and is ~0 when the engine has stalled.
  const rec = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM discovered_link
      WHERE http_status IS NOT NULL AND updated_at > now() - interval '10 minutes'`,
  );
  const recentVisited = rec[0]?.n ?? 0;
  const recentPagesPerMin = recentVisited / 10;

  // The REAL remaining work for active universities = links discovered but not yet
  // visited (the frontier). Truthful — no guessing a per-uni page total.
  const fr = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM discovered_link dl JOIN university u ON u.id = dl.university_id
      WHERE dl.http_status IS NULL AND u.crawl_status IN ('DISCOVERING','QUEUED')`,
  );
  const remainingFrontier = fr[0]?.n ?? 0;
  // How long the in-progress wave has ALREADY been crawling (oldest RUNNING job).
  // The budget-based ETA must subtract this so it counts DOWN in real time instead
  // of sitting pinned at the full per-university budget for the whole crawl.
  const runJob = await prisma.$queryRawUnsafe<{ secs: number | null }[]>(
    `SELECT EXTRACT(EPOCH FROM (now() - min(started_at)))::float AS secs
       FROM crawl_job WHERE status = 'RUNNING' AND started_at IS NOT NULL`,
  );
  const runningElapsed = Math.max(0, runJob[0]?.secs ?? 0);
  // Each university is hard-capped at MAX_CRAWL_MINUTES; with `browsers` running in
  // parallel the batch drains in `waves`. The CURRENT wave has already burned
  // `runningElapsed`, so only its REMAINING budget counts — that's what makes the
  // ETA tick down live instead of freezing at the full budget.
  const budgetSecs = (settings.MAX_CRAWL_MINUTES > 0 ? settings.MAX_CRAWL_MINUTES : 40) * 60;
  const waves = Math.ceil(activeRemaining / Math.max(1, browsers));
  const etaBudget = Math.max(0, (waves - 1) * budgetSecs + Math.max(0, budgetSecs - runningElapsed));

  let etaSeconds: number | null = null;
  let pagesPerMin: number | null = recentPagesPerMin >= 1 ? Math.round(recentPagesPerMin) : null;
  // STALLED = something should be crawling, but no pages have been recorded for a
  // while (engine crashed / jobs orphaned). Surfaced so the UI can tell the user.
  let stalled = false;

  if (!crawling) {
    etaSeconds = completed === unis.length && unis.length > 0 ? 0 : null;
  } else if (recentPagesPerMin >= 1) {
    // Finishes when the frontier is crawled OR the time budget is hit — whichever
    // comes first. min() of the two keeps the ETA honest and never absurd.
    const etaPages = Math.round((remainingFrontier / recentPagesPerMin) * 60);
    etaSeconds = Math.min(etaPages, etaBudget);
  } else {
    // crawling flag set but no recent pages → the crawl is stalled, not slow.
    stalled = true;
  }

  return {
    total: unis.length,
    completed,
    remaining,
    activeRemaining,
    byStatus,
    links: a.links,
    intlLinks: a.intl,
    snapshots: a.snaps,
    pagesCrawled: a.visited, // pages actually visited (real crawl progress)
    pagesPerMin,
    elapsedSeconds: elapsed ? Math.round(elapsed) : null,
    progressPct: batchTotal > 0 ? Math.min(99, Math.round((effectiveDone / batchTotal) * 100)) : crawling ? 0 : 100,
    avgSecondsPerUniversity: avgSecs ? Math.round(avgSecs) : null,
    etaSeconds,
    etaHuman: etaSeconds === null ? null : etaSeconds === 0 ? "Done" : formatDuration(etaSeconds),
    stalled,
    universities: unis,
  };
}
