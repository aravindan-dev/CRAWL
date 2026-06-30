import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import ExcelJS from "exceljs";
import { repoRoot, getKeywords, keywordsToRegex } from "@clg/shared";
import { prisma } from "@clg/database";

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
// Pages that mention scholarships but aren't really a scholarship page.
const NOISE = /\.(pdf|xlsx?|docx?|jpe?g|png)(\?|$)|\/news\/|\/blog\/|\/events?\/|\/staff\//i;

const isWorking = (status: string, http: number | null) =>
  http !== null ? http >= 200 && http < 400 : ["VALID_COURSE_PAGE", "VALID_ADMISSION_PAGE", "POSSIBLE_REQUIREMENT_PAGE"].includes(status);

interface SchRow { university: string; country: string; level: "university" | "course"; title: string; url: string }

/** Build the separate scholarship deliverable from the crawled links. */
export async function exportScholarships(): Promise<{ file: string; total: number; universityUrls: number; courseUrls: number }> {
  const unis = await prisma.university.findMany({ select: { id: true, name: true, country: true }, orderBy: { name: "asc" } });
  const seen = new Set<string>();
  const rows: SchRow[] = [];

  for (const u of unis) {
    const links = await prisma.discoveredLink.findMany({
      where: { university_id: u.id },
      select: { url: true, final_url: true, page_title: true, status: true, http_status: true },
    });
    for (const l of links) {
      const url = l.final_url ?? l.url;
      const low = url.toLowerCase();
      const title = (l.page_title ?? "").toLowerCase();
      if (NOISE.test(low)) continue;
      if (!SCH.test(low) && !SCH.test(title)) continue; // must be a scholarship page
      if (!isWorking(l.status, l.http_status)) continue;
      const key = url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ university: u.name, country: u.country, level: COURSE_RE.test(low) ? "course" : "university", title: l.page_title ?? "", url });
    }
  }

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
