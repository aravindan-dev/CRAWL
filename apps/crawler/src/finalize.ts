/**
 * Autonomous finalizer (run as a Scheduled Task so it survives console signals).
 *
 *  1. Waits until all 37 universities finish crawling (status no longer
 *     QUEUED/DISCOVERING), or a max deadline.
 *  2. Gathers every eligibility/criteria URL (university + course) per the URL
 *     filters.
 *  3. HTTP-validates each (HEAD→GET, follow redirects), then RE-CHECKS transient
 *     failures (timeout/5xx/429) once at low concurrency for maximum accuracy.
 *  4. Writes storage/exports/eligibility-urls-final.{csv,xlsx} (formatted, with
 *     a per-university Summary sheet).
 *
 * Run: tsx src/finalize.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "@clg/database";
import { repoRoot, env } from "@clg/shared";

const ELIG_URL =
  /(admission|entry[-_]?requirement|requirements?|eligib|how[-_]?to[-_]?apply|application|qualif|ucas|prerequisite|entry[-_]?criteria|tariff|\/apply(\/|$)|\/entry(\/|$))/i;
const COURSE_URL =
  /(\/courses?\/|\/programmes?\/|\/programs?\/|\/degrees?\/|\/undergraduate\/[^/]+|\/study\/[^/]+|bachelor|-bsc\b|-bs\b|-ba\b|-beng\b|-bba\b|-llb\b|-msc\b|-ma\b)/i;
const DENY_URL =
  /(imprint|about[-_]?us|newsroom|press|\/research|campus[-_]?map|data[-_]?protection|accessibility|gender[-_]?equality|\/history|\/contact|privacy|sitemap|\/login|\/people\/|\/staff|\/profile\/|\/news\/|\/events?\/|cookie|mailto:|href=)/i;
const SKIP_STATUS = new Set(["DUPLICATE"]);

const MAIN_CONCURRENCY = 10;
const RETRY_CONCURRENCY = 4;
const TIMEOUT_MS = 15000;
const RETRY_TIMEOUT_MS = 25000;
const MAX_WAIT_MIN = 150;

type Result = "OK" | "REDIRECTED_OK" | "NOT_FOUND" | "BLOCKED" | "RATE_LIMITED" | "SERVER_ERROR" | "FAILED" | "UNREACHABLE";
const TRANSIENT = new Set<Result>(["UNREACHABLE", "SERVER_ERROR", "RATE_LIMITED"]);

interface Row {
  university: string;
  country: string;
  level: "university" | "course";
  score: number;
  url: string;
  http_status: number | null;
  final_url: string;
  result: Result;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function classify(status: number | null, redirected: boolean): Result {
  if (status === null) return "UNREACHABLE";
  if (status >= 200 && status < 300) return redirected ? "REDIRECTED_OK" : "OK";
  if (status === 404 || status === 410) return "NOT_FOUND";
  if (status === 401 || status === 403) return "BLOCKED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "FAILED";
}

async function checkUrl(url: string, timeout: number): Promise<{ status: number | null; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { "user-agent": env.USER_AGENT } as Record<string, string>;
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal, headers });
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal, headers });
    }
    return { status: res.status, finalUrl: res.url || url };
  } catch {
    return { status: null, finalUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

async function pool<T>(items: T[], limit: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      await fn(items[cur]!, cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function waitForCrawl(): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MIN * 60_000;
  for (;;) {
    // Pending = anything NOT terminal (so IDLE during a resume also counts as
    // pending — prevents the finalizer firing early before re-enqueue).
    const pending = await prisma.university.count({
      where: { crawl_status: { notIn: ["COMPLETED", "FAILED", "STOPPED"] } },
    });
    const done = await prisma.university.count({ where: { crawl_status: { in: ["COMPLETED", "FAILED", "STOPPED"] } } });
    console.log(`[wait] done=${done} pending=${pending} ${new Date().toISOString()}`);
    if (pending === 0) return;
    if (Date.now() > deadline) {
      console.log(`[wait] deadline reached; proceeding with ${pending} still pending`);
      return;
    }
    await sleep(30_000);
  }
}

async function gatherTargets(): Promise<Row[]> {
  const unis = await prisma.university.findMany({ orderBy: { name: "asc" } });
  const rows: Row[] = [];
  for (const u of unis) {
    const links = await prisma.discoveredLink.findMany({ where: { university_id: u.id }, orderBy: [{ link_score: "desc" }] });
    const seen = new Set<string>();
    for (const l of links) {
      if (SKIP_STATUS.has(l.status)) continue;
      const url = (l.final_url ?? l.url).trim();
      const low = url.toLowerCase();
      if (DENY_URL.test(low) || seen.has(low)) continue;
      const isCourse = COURSE_URL.test(low);
      const isElig = ELIG_URL.test(low);
      if (!isCourse && !isElig) continue;
      seen.add(low);
      rows.push({
        university: u.name,
        country: u.country,
        level: isCourse ? "course" : "university",
        score: l.link_score,
        url,
        http_status: null,
        final_url: url,
        result: "UNREACHABLE",
      });
    }
  }
  return rows;
}

async function validate(rows: Row[]): Promise<void> {
  let done = 0;
  await pool(rows, MAIN_CONCURRENCY, async (r) => {
    const { status, finalUrl } = await checkUrl(r.url, TIMEOUT_MS);
    r.http_status = status;
    r.final_url = finalUrl;
    r.result = classify(status, finalUrl !== r.url);
    if (++done % 200 === 0) console.log(`[check] ${done}/${rows.length}`);
  });

  const retries = rows.filter((r) => TRANSIENT.has(r.result));
  if (retries.length) {
    console.log(`[retry] re-checking ${retries.length} transient failures at low concurrency`);
    await pool(retries, RETRY_CONCURRENCY, async (r) => {
      await sleep(250);
      const { status, finalUrl } = await checkUrl(r.url, RETRY_TIMEOUT_MS);
      // Only upgrade the result; keep the better of the two.
      const res = classify(status, finalUrl !== r.url);
      if (res === "OK" || res === "REDIRECTED_OK" || !TRANSIENT.has(res)) {
        r.http_status = status;
        r.final_url = finalUrl;
        r.result = res;
      }
    });
  }
}

function csvCell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

async function writeOutputs(rows: Row[]): Promise<void> {
  rows.sort((a, b) =>
    a.university === b.university ? (a.level === b.level ? a.url.localeCompare(b.url) : a.level.localeCompare(b.level)) : a.university.localeCompare(b.university),
  );
  const dir = join(repoRoot(), "storage", "exports");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();

  // --- CSV ---
  const head = ["university", "country", "level", "link_score", "url", "http_status", "result", "final_url", "checked_at"];
  const lines = [head.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([csvCell(r.university), csvCell(r.country), csvCell(r.level), csvCell(r.score), csvCell(r.url), csvCell(r.http_status), csvCell(r.result), csvCell(r.final_url), csvCell(now)].join(","));
  }
  writeFileSync(join(dir, "eligibility-urls-final.csv"), lines.join("\r\n"), "utf8");

  // --- XLSX ---
  const working = (r: Row) => r.result === "OK" || r.result === "REDIRECTED_OK";
  const wb = new ExcelJS.Workbook();

  // Summary sheet
  const sum = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  sum.columns = [
    { header: "University", key: "u", width: 42 },
    { header: "Country", key: "c", width: 16 },
    { header: "University URLs", key: "uni", width: 16 },
    { header: "Course URLs", key: "course", width: 14 },
    { header: "Total", key: "total", width: 10 },
    { header: "Working", key: "ok", width: 10 },
    { header: "Broken (404)", key: "broken", width: 13 },
  ];
  const byUni = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byUni.get(r.university) ?? [];
    arr.push(r);
    byUni.set(r.university, arr);
  }
  for (const [name, arr] of byUni) {
    sum.addRow({
      u: name,
      c: arr[0]?.country ?? "",
      uni: arr.filter((r) => r.level === "university").length,
      course: arr.filter((r) => r.level === "course").length,
      total: arr.length,
      ok: arr.filter(working).length,
      broken: arr.filter((r) => r.result === "NOT_FOUND").length,
    });
  }
  sum.addRow({});
  sum.addRow({
    u: "TOTAL",
    c: `${byUni.size} universities`,
    uni: rows.filter((r) => r.level === "university").length,
    course: rows.filter((r) => r.level === "course").length,
    total: rows.length,
    ok: rows.filter(working).length,
    broken: rows.filter((r) => r.result === "NOT_FOUND").length,
  });
  sum.getRow(1).font = { bold: true };
  sum.lastRow!.font = { bold: true };

  // All URLs sheet
  const ws = wb.addWorksheet("All URLs", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "University", key: "university", width: 40 },
    { header: "Country", key: "country", width: 14 },
    { header: "Level", key: "level", width: 12 },
    { header: "Score", key: "score", width: 8 },
    { header: "URL", key: "url", width: 80 },
    { header: "HTTP", key: "http", width: 8 },
    { header: "Result", key: "result", width: 15 },
    { header: "Final URL", key: "final", width: 80 },
  ];
  for (const r of rows) {
    const row = ws.addRow({
      university: r.university,
      country: r.country,
      level: r.level,
      score: r.score,
      url: r.url,
      http: r.http_status,
      result: r.result,
      final: r.final_url,
    });
    const urlCell = row.getCell("url");
    urlCell.value = { text: r.url, hyperlink: r.url };
    urlCell.font = { color: { argb: "FF0563C1" }, underline: true };
    const resCell = row.getCell("result");
    resCell.font = {
      bold: true,
      color: { argb: working(r) ? "FF1E7B34" : r.result === "NOT_FOUND" ? "FFC00000" : "FFBF8F00" },
    };
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: "A1", to: "H1" };

  await wb.xlsx.writeFile(join(dir, "eligibility-urls-final.xlsx"));

  const tally: Record<string, number> = {};
  for (const r of rows) tally[r.result] = (tally[r.result] ?? 0) + 1;
  console.log(`FINAL total=${rows.length} working=${rows.filter(working).length} not_found=${tally.NOT_FOUND ?? 0} unreachable=${tally.UNREACHABLE ?? 0} blocked=${tally.BLOCKED ?? 0}`);
  console.log(`WROTE ${join(dir, "eligibility-urls-final.xlsx")}`);
  console.log(`WROTE ${join(dir, "eligibility-urls-final.csv")}`);
}

async function main() {
  console.log(`[finalize] start ${new Date().toISOString()}`);
  // SKIP_WAIT=1 runs the validate+export path immediately on current data
  // (used to smoke-test the Excel writer without waiting for the full crawl).
  if (process.env.SKIP_WAIT === "1") console.log("[finalize] SKIP_WAIT set — exporting current data");
  else await waitForCrawl();
  const rows = await gatherTargets();
  console.log(`[finalize] gathered ${rows.length} eligibility URLs`);
  await prisma.$disconnect();
  await validate(rows);
  await writeOutputs(rows);
  console.log(`[finalize] done ${new Date().toISOString()}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FINALIZE_ERROR", err);
  process.exit(1);
});
