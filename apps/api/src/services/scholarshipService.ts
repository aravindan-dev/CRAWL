import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import ExcelJS from "exceljs";
import { repoRoot, getKeywords, keywordsToRegex, registrableDomain, codepointCompare, datasetHash, vocabHash, rejectScholarship, isDomesticPath, isDomesticText } from "@clg/shared";
import { prisma } from "@clg/database";
import { readSetting } from "./settingsService.js";

/**
 * SCHOLARSHIP module — completely separate from eligibility. Scans the crawled
 * links for SCHOLARSHIP / funding pages (URL or page title matches the editable
 * scholarship keyword list), splits them into university-level vs course-level,
 * and writes its OWN Excel + CSV (never mixed with the eligibility export).
 */
const DIR = resolve(repoRoot(), "storage", "exports");
const XLSX = join(DIR, "scholarships-INTERNATIONAL-FINAL.xlsx");
const CSV = join(DIR, "scholarships-INTERNATIONAL-FINAL.csv");

const SCH = keywordsToRegex(getKeywords().scholarship);
// Same course/university split used by the eligibility module.
const COURSE_RE = /(\/courses?\/|\/programmes?\/|\/programs?\/|\/degrees?\/|\/undergraduate\/[^/]+|\/postgraduate\/[^/]+|bachelor|master|-bsc\b|-bs\b|-ba\b|-beng\b|-bba\b|-llb\b|-msc\b|-ma\b)/i;
// Precision filters (blog/article pages, fee pages, category listings, login/auth,
// external sites) live in @clg/shared (scholarship/filters) — SHARED with the live
// feed route AND the crawler's classifier, so every stage agrees on what counts.

// FINAL SAFETY GATE: page classes that must never ship as scholarships. The
// crawl engine already rejects these before fetch (context isolation) — this
// is only the last line of defense, never the primary fix.
const NON_SCHOLARSHIP_CLASSES = new Set([
  "COURSE_PAGE", "COURSE_LISTING", "ELIGIBILITY_PAGE", "ADMISSIONS_PAGE", "INTERNATIONAL_ADMISSIONS_PAGE",
]);

const isWorking = (status: string, http: number | null) =>
  http !== null ? http >= 200 && http < 400 : ["VALID_COURSE_PAGE", "VALID_ADMISSION_PAGE", "POSSIBLE_REQUIREMENT_PAGE"].includes(status);

interface SchRow { university: string; country: string; level: "university" | "course"; title: string; url: string }

/** Build the separate scholarship deliverable from the crawled links. */
export async function exportScholarships(): Promise<{ file: string; total: number; universityUrls: number; courseUrls: number }> {
  // AUDIENCE (Settings → "Find eligibility for…"): "international" (default)
  // drops scholarships explicitly scoped to domestic/home students — this
  // product exists to find INTERNATIONAL-student scholarships. "all" keeps them.
  // Read fresh (not cached) so a Settings change applies on the next export
  // without an API restart.
  const audience = readSetting("AUDIENCE") || "international";
  const unis = await prisma.university.findMany({ select: { id: true, name: true, country: true, base_url: true }, orderBy: { name: "asc" } });
  const seen = new Set<string>();
  const rows: SchRow[] = [];
  // FEED ALIGNMENT: scholarship-looking links that fail the precision filters
  // (blog articles, fee pages, category listings, login) get content_verified
  // turned OFF so the live "Validated URLs" feed shows exactly the exported set.
  const unverify: string[] = [];
  const verify: string[] = [];

  for (const u of unis) {
    // Same-institution guard: a scholarship page must live on the university's own
    // registrable domain, so external aggregators (e.g. studyaustralia.gov.au) that
    // merely mention "scholarships" are dropped. research/study/www subdomains all
    // share the registrable domain (csu.edu.au) so legitimate ones are kept.
    let uniReg = "";
    try { uniReg = registrableDomain(new URL(u.base_url).hostname); } catch { /* leave blank → domain check skipped */ }
    // CONTEXT ISOLATION: the scholarship deliverable comes from SCHOLARSHIP-crawl
    // rows. Legacy databases (crawled before context isolation) have none — for
    // those, fall back to scanning the legacy rows so existing deliverables don't
    // vanish until the first context-aware crawl runs.
    const select = { id: true, url: true, final_url: true, page_title: true, status: true, http_status: true, content_verified: true, page_class: true } as const;
    let links = await prisma.discoveredLink.findMany({
      where: { university_id: u.id, crawl_context: "SCHOLARSHIP", status: { not: "REJECTED_CROSS_CONTEXT" } },
      select,
    });
    if (links.length === 0) {
      links = await prisma.discoveredLink.findMany({
        where: { university_id: u.id, status: { not: "REJECTED_CROSS_CONTEXT" } },
        select,
      });
    }
    for (const l of links) {
      // Final safety gate: a page the crawler classified as course/eligibility
      // can never ship in the scholarship file, whatever its keywords say.
      if (l.page_class && NON_SCHOLARSHIP_CLASSES.has(l.page_class)) continue;
      const url = l.final_url ?? l.url;
      const low = url.toLowerCase();
      const title = (l.page_title ?? "").toLowerCase();
      if (!SCH.test(low) && !SCH.test(title)) continue; // must be a scholarship page
      if (audience !== "all" && (isDomesticPath(url) || isDomesticText(l.page_title ?? ""))) {
        // Crawl-time validation was keyword-based and let this through (or the
        // setting changed since); the export is the precision pass — reflect the
        // exclusion in the live feed too.
        if (l.content_verified) unverify.push(l.id);
        continue;
      }
      if (rejectScholarship(url, uniReg)) {
        // Crawl-time validation was keyword-based and let this through; the export
        // is the precision pass — reflect the rejection in the live feed too.
        if (l.content_verified) unverify.push(l.id);
        continue;
      }
      if (!isWorking(l.status, l.http_status)) continue;
      const key = url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!l.content_verified) verify.push(l.id); // exported ⇒ visible in the live feed
      rows.push({ university: u.name, country: u.country, level: COURSE_RE.test(low) ? "course" : "university", title: l.page_title ?? "", url });
    }
  }

  // Persist the feed alignment (best-effort; the files below are the deliverable).
  if (unverify.length) {
    await prisma.discoveredLink.updateMany({ where: { id: { in: unverify } }, data: { content_verified: false } }).catch(() => {});
  }
  if (verify.length) {
    await prisma.discoveredLink.updateMany({ where: { id: { in: verify } }, data: { content_verified: true } }).catch(() => {});
  }

  // DETERMINISTIC output order (codepoint, never locale-dependent) + dataset hash:
  // two runs on an unchanged crawl must produce byte-identical files.
  rows.sort((a, b) =>
    a.university === b.university
      ? a.level === b.level
        ? codepointCompare(a.url, b.url)
        : codepointCompare(a.level, b.level)
      : codepointCompare(a.university, b.university),
  );
  const dsHash = datasetHash(rows.map((r) => [r.university, r.country, r.level, r.title, r.url]));
  console.log(`[scholarships] ${rows.length} rows  dataset_hash=${dsHash}  vocab=${vocabHash()}`);

  mkdirSync(DIR, { recursive: true });
  const cell = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["university", "country", "level", "page_title", "scholarship_url"];
  const csv = [head.map(cell).join(",")]
    .concat(rows.map((r) => [r.university, r.country, r.level, r.title, r.url].map(cell).join(",")))
    .join("\r\n");
  writeFileSync(CSV, csv, "utf8");

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Scholarship URLs");
  ws.columns = [
    { header: "University", key: "university", width: 42 },
    { header: "Country", key: "country", width: 16 },
    { header: "Level", key: "level", width: 12 },
    { header: "Page title", key: "title", width: 45 },
    { header: "Scholarship URL", key: "url", width: 72 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  await wb.xlsx.writeFile(XLSX);

  const universityUrls = rows.filter((r) => r.level === "university").length;
  const courseUrls = rows.filter((r) => r.level === "course").length;
  return { file: "scholarships-INTERNATIONAL-FINAL.xlsx", total: rows.length, universityUrls, courseUrls };
}

/** Counts from the last scholarship export (for the dashboard). */
export function scholarshipCounts(): { universityUrls: number; courseUrls: number; totalUrls: number; generatedAt: string | null } {
  if (!existsSync(CSV)) return { universityUrls: 0, courseUrls: 0, totalUrls: 0, generatedAt: null };
  let university = 0;
  let course = 0;
  try {
    const lines = readFileSync(CSV, "utf8").trim().split(/\r?\n/).slice(1);
    for (const line of lines) {
      if (/"course"/.test(line)) course += 1;
      else if (/"university"/.test(line)) university += 1;
    }
  } catch { /* ignore */ }
  return { universityUrls: university, courseUrls: course, totalUrls: university + course, generatedAt: statSync(CSV).mtime.toISOString() };
}
