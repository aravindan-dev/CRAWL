import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import os from "node:os";
import { repoRoot, codepointCompare } from "@clg/shared";
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
  MAX_CRAWL_MINUTES: 40, // SOFT time target per university — never truncates a crawl (0 = no notice)
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
const SCHOLARSHIP_CSV = "scholarships-INTERNATIONAL-FINAL.csv";
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
  level: "university" | "course" | "scholarship";
  course_name: string;
  url: string;
  http_status: string;
  validity: string;
}
export interface VerifiedCounts {
  courseUrls: number;
  universityUrls: number;
  scholarshipUrls: number;
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
  // header: university,country,level,course_name,eligibility_url,http_status,validity,
  //         eligibility_anchor_url
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

/** Read the SCHOLARSHIP export CSV (its own schema: university,country,level,
 *  page_title,scholarship_url) into verified rows grouped by university name.
 *  Only working links are exported, so validity is always WORKING. */
function readScholarshipDeliverable(path: string): Map<string, VerifiedUrlRow[]> {
  const m = new Map<string, VerifiedUrlRow[]>();
  if (!existsSync(path)) return m;
  const txt = readFileSync(path, "utf8").replace(/^﻿/, "");
  const rows = parseCsv(txt);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const name = normUniName(r[0] ?? "");
    if (!name) continue;
    const list = m.get(name) ?? m.set(name, []).get(name)!;
    list.push({
      level: "scholarship",
      course_name: (r[3] ?? "").replace(/\s+-\s+(scholarships?|research)\s*$/i, ""), // strip the " - Scholarships" site suffix
      url: r[4] ?? "",
      http_status: "",
      validity: "WORKING",
    });
  }
  return m;
}

let deliverableCache: { key: string; map: Map<string, VerifiedUrlRow[]> } | null = null;

// Order of the three sections in the drawer: main university URL → courses → scholarships.
const LEVEL_ORDER: Record<VerifiedUrlRow["level"], number> = { university: 0, course: 1, scholarship: 2 };

/** All verified deliverable rows per university, cached by export-file mtime. */
function getVerifiedRowsByUniversity(): Map<string, VerifiedUrlRow[]> {
  const dir = exportsDir();
  const cPath = join(dir, COURSES_CSV);
  const uPath = join(dir, UNIVERSITY_CSV);
  const sPath = join(dir, SCHOLARSHIP_CSV);
  const mt = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  const key = `${mt(cPath)}:${mt(uPath)}:${mt(sPath)}`;
  if (deliverableCache && deliverableCache.key === key) return deliverableCache.map;

  const map = new Map<string, VerifiedUrlRow[]>();
  for (const src of [readDeliverable(cPath), readDeliverable(uPath), readScholarshipDeliverable(sPath)]) {
    for (const [name, rows] of src) {
      const list = map.get(name) ?? map.set(name, []).get(name)!;
      list.push(...rows);
    }
  }
  // University-level links first, then courses A→Z, then scholarships A→Z.
  for (const list of map.values()) {
    list.sort((a, b) =>
      a.level === b.level ? codepointCompare(a.course_name, b.course_name) : LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level],
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
  let scholarshipUrls = 0;
  for (const r of rows) r.level === "course" ? (courseUrls += 1) : r.level === "scholarship" ? (scholarshipUrls += 1) : (universityUrls += 1);
  return { courseUrls, universityUrls, scholarshipUrls, validUrls: courseUrls + universityUrls + scholarshipUrls };
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

  // DELIVERABLE-WEIGHTED frontier maths (progress + ETA share one honest model).
  // Split each in-progress university's PENDING work by tier, because not all
  // "pending" links are equal work toward the deliverable:
  //   - QUEUED (EXTRACT tier, score ≥ threshold) = course/eligibility candidates,
  //     the REAL work → full weight.
  //   - LOW_CONFIDENCE_PAGE (discover-only nav/section pages) → mostly dead-end
  //     or get branch-pruned before spawning more, so they count at a reduced
  //     weight (a crawl with 50 course pages + 3000 nav pages left is ~90% done
  //     on the deliverable, not 50%).
  //   - Terminal pending (BLOCKED / PDF_DEFERRED / REJECTED_CROSS_CONTEXT /
  //     BROKEN_LINK) is http_status-NULL yet will NEVER be fetched — EXCLUDED
  //     entirely. The old frontier counted these (raw `http_status IS NULL`),
  //     which permanently inflated the ETA (observed: 1,234 uncrawlable rows
  //     padding a single university's frontier → an 11h ETA on a ~2h crawl).
  const LOW_TIER_WEIGHT = 0.35;
  const inProg = await prisma.$queryRawUnsafe<{ visited: number; queued_pending: number; low_pending: number }[]>(
    `SELECT count(dl.id) FILTER (WHERE dl.http_status IS NOT NULL)::int AS visited,
            count(dl.id) FILTER (WHERE dl.http_status IS NULL AND dl.status = 'QUEUED')::int AS queued_pending,
            count(dl.id) FILTER (WHERE dl.http_status IS NULL AND dl.status = 'LOW_CONFIDENCE_PAGE')::int AS low_pending
       FROM university u JOIN discovered_link dl ON dl.university_id = u.id
      WHERE u.crawl_status = 'DISCOVERING'
      GROUP BY u.id`,
  );
  const weightedRemainingPerUni = inProg.map((r) => (r.queued_pending || 0) + (r.low_pending || 0) * LOW_TIER_WEIGHT);
  const weightedRemainingFrontier = weightedRemainingPerUni.reduce((s, x) => s + x, 0);
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

  // RECENT DISCOVERY rate (new links created in the last 10 min) — the missing
  // signal in the old ETA. A crawl is in one of two phases: EXPANSION (each
  // visit spawns many new links → the frontier grows) or DRAIN (few new links →
  // the frontier empties at ~visit rate). Dividing the frontier by the visit
  // rate is only meaningful in the DRAIN phase; during EXPANSION it produces a
  // fictional multi-hour number. `discoveryRatio` (new-links ÷ visits) tells us
  // which phase we're in so the ETA can say "still discovering" honestly.
  const recNew = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM discovered_link dl JOIN university u ON u.id = dl.university_id
      WHERE u.crawl_status = 'DISCOVERING' AND dl.created_at > now() - interval '10 minutes'`,
  );
  const recentCreated = recNew[0]?.n ?? 0;
  const discoveryRatio = recentVisited > 0 ? recentCreated / recentVisited : 0;

  // RECENT validation throughput (last 10 min) — pagesPerMin above counts EVERY
  // page fetch (discovery/nav/duplicate/rejected included), so a healthy
  // pages/min can sit alongside zero new validated targets when the crawl is
  // churning through a low-value section. Surfacing this separately makes that
  // visible instead of reading as "143 pages/min but nothing is happening".
  const recV = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM discovered_link
      WHERE content_verified = true AND updated_at > now() - interval '10 minutes'`,
  );
  const recentValidatedPerMin = (recV[0]?.n ?? 0) / 10;

  // Wall-clock since the engine last TOUCHED any link row — successful visits,
  // FAILED attempts and fresh discoveries all count as life signs. Filtering to
  // http_status IS NOT NULL here was the false-stall bug that made the watchdog
  // kill a HEALTHY engine: a frontier stretch of 403-retrying/robots-blocked pages
  // updates rows *without* http_status, the detector saw "silence", and the
  // escalation taskkilled the crawler mid-crawl (observed as 77 silent restarts).
  const lastAct = await prisma.$queryRawUnsafe<{ last: Date | null }[]>(
    `SELECT max(updated_at) AS last FROM discovered_link`,
  );
  const lastActivityMs = lastAct[0]?.last ? new Date(lastAct[0].last).getTime() : null;
  const lastActivityAt = lastActivityMs ? new Date(lastActivityMs).toISOString() : null;

  // --- V4 Metrics ---
  const v4Logs = await prisma.$queryRawUnsafe<{ action: string; message: string; created_at: Date }[]>(
    `SELECT action, message, created_at FROM crawl_log
     WHERE message LIKE 'V4 %' OR message LIKE 'DEEP_DISCOVERY%'
     ORDER BY created_at DESC LIMIT 50`
  );
  
  let earlyStops = 0;
  let deepPasses = 0;
  for (const l of v4Logs) {
    if (l.message.includes("Early success triggered")) earlyStops++;
    if (l.message.includes("DEEP_DISCOVERY pass")) deepPasses++;
  }

  // Parse the most recent METRICS log for live crawler state
  const metricsLogs = await prisma.$queryRawUnsafe<{ message: string }[]>(
    `SELECT message FROM crawl_log WHERE message LIKE 'METRICS[%' ORDER BY created_at DESC LIMIT 1`
  );
  let browserFallback = 0;
  let blockedDomains = 0;
  let confidenceScore = 0;
  if (metricsLogs.length > 0) {
    const msg = metricsLogs[0]?.message || "";
    const matchFallback = msg.match(/browserFallback=(\d+)/);
    if (matchFallback) browserFallback = parseInt(matchFallback[1] || "0", 10);
    const matchBlocked = msg.match(/v4Blocked=([^ ]+)/);
    if (matchBlocked && (matchBlocked[1] || "") !== "none") blockedDomains = (matchBlocked[1] || "").split(",").length;
    const matchConf = msg.match(/v4Confidence=(\d+)/);
    if (matchConf) confidenceScore = parseInt(matchConf[1] || "0", 10);
  }

  const totalMem = os.totalmem() || 1;
  const memoryUsage = Math.round((1 - (os.freemem() || 0) / totalMem) * 100);
  const cpuCores = os.cpus()?.length || 1;
  const cpuUsage = Math.round(((os.loadavg()?.[0] || 0) / cpuCores) * 100);

  // How long the in-progress wave has ALREADY been crawling (oldest RUNNING job).
  // The budget-based ETA must subtract this so it counts DOWN in real time instead
  // of sitting pinned at the full per-university budget for the whole crawl.
  const runJob = await prisma.$queryRawUnsafe<{ secs: number | null }[]>(
    `SELECT EXTRACT(EPOCH FROM (now() - min(started_at)))::float AS secs
       FROM crawl_job WHERE status = 'RUNNING' AND started_at IS NOT NULL`,
  );
  const runningElapsed = Math.max(0, runJob[0]?.secs ?? 0);

  const pagesPerMin: number | null = recentPagesPerMin >= 1 ? Math.round(recentPagesPerMin) : null;
  // STALLED = something should be crawling but no pages have been recorded for the
  // whole grace window (engine crashed / jobs orphaned — commonly an OOM kill).
  const STALL_GRACE_SECONDS = 300;
  const sinceLastActivitySec = lastActivityMs ? (Date.now() - lastActivityMs) / 1000 : Infinity;
  const stalled = crawling && recentPagesPerMin < 1 && sinceLastActivitySec >= STALL_GRACE_SECONDS;

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
    validatedPerMin: recentValidatedPerMin >= 0.1 ? Math.round(recentValidatedPerMin * 10) / 10 : 0,
    elapsedSeconds: elapsed ? Math.round(elapsed) : null,
    avgSecondsPerUniversity: avgSecs ? Math.round(avgSecs) : null,
    // CRAWL PHASE: "discovering" while the frontier is still expanding, "finishing"
    // once discovery has saturated, else idle/done. There is deliberately NO page-%
    // or time ETA — a crawl cannot know a site's total page count up front, so any
    // percentage or "time remaining" would be a guess.
    phase: !crawling
      ? (completed === unis.length && unis.length > 0 ? "done" : "idle")
      : discovering > 0
        ? "discovering"
        : "finishing",
    // Weighted remaining work (course/eligibility candidates full weight, low-value
    // nav pages discounted, uncrawlable excluded) — the honest "work left" figure.
    remainingWork: Math.round(weightedRemainingFrontier),
    discoveryRatio: Math.round(discoveryRatio * 100) / 100,
    stalled,
    lastActivityAt,
    // How long the stall has lasted — capped to the current wave's running time so
    // it never reports an inflated gap left over from a previous crawl.
    stalledForSeconds: stalled ? Math.round(Math.min(runningElapsed, sinceLastActivitySec)) : null,
    // V4 Metrics
    v4EarlyStops: earlyStops,
    v4DeepPasses: deepPasses,
    browserFallback,
    blockedDomains,
    confidenceScore,
    memoryUsage,
    cpuUsage,
    universities: unis,
  };
}
