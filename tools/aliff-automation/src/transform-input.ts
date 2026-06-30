/**
 * Transform the crawler's VALIDATED eligibility URLs into the Aliff-automation
 * input schema. Produces TWO files in data/:
 *   - aliff-input-all.xlsx          (all validated eligibility URLs)
 *   - aliff-input-international.xlsx (international-student ENTRY URLs only)
 *
 * Only valid URLs (working / browser-verified, ~99.3%) are used — the input is
 * the recheck output (eligibility-urls-FINAL.csv, fallback eligibility-urls-CLEAN.csv).
 *
 * Course names are derived from the URL slug (the crawl captured URLs, not names)
 * and flagged in `notes` — verify before committing course records.
 *
 * Run: tsx src/transform-input.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import XLSX from "xlsx";
import ExcelJS from "exceljs";

const readWorkbook = (path: string) => XLSX.read(readFileSync(path));

const PROJECT_ROOT = join(process.cwd(), "..", ".."); // tools/aliff-automation -> repo root
const EXPORT_DIR = join(PROJECT_ROOT, "storage", "exports");
const REF_CSV = join(PROJECT_ROOT, "samples", "universities_R-S_verified.csv");
const OUT_DIR = join(process.cwd(), "data");

// International-student ENTRY signal in the URL path. Broadened beyond literal
// "international" to the topics that ARE international entry: country-specific
// requirement pages, English-language requirements, and student-visa pages.
const INTERNATIONAL = new RegExp(
  [
    "international", "\\/intl\\b", "overseas", "non[-_]?eu\\b", "\\/eu[-_/]",
    "foreign[-_ ]?students?", "study[-_ ]?abroad",
    // country-specific entry requirement pages
    "your[-_ ]?country", "country[-_ ]?or[-_ ]?territory", "\\/countries?\\/", "by[-_ ]?country",
    // English-language proficiency (an international entry requirement)
    "english[-_ ]?language", "language[-_ ]?requirements?", "\\bielts\\b", "\\btoefl\\b", "\\bpte\\b", "duolingo",
    // visa / clearance (international applicants)
    "student[-_ ]?visa", "\\/visa\\b", "tier[-_ ]?4", "entry[-_ ]?clearance",
    // qualification equivalence for overseas applicants
    "equivalenc", "international[-_ ]?qualif",
  ].join("|"),
  "i",
);

interface ValidRow {
  university: string;
  country: string;
  level: "university" | "course";
  course_name: string;
  url: string;
}

function readValidUrls(fileName: string): ValidRow[] {
  const path = join(EXPORT_DIR, fileName);
  if (!existsSync(path)) throw new Error(`No validated export found at ${path}. Run the crawler recheck first.`);
  const wb = readWorkbook(path);
  const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { defval: "" });
  return rows
    .map((r) => ({
      university: String(r.university ?? "").trim(),
      country: String(r.country ?? "").trim(),
      level: (String(r.level ?? "").trim() === "university" ? "university" : "course") as ValidRow["level"],
      course_name: String(r.course_name ?? "").trim(),
      url: String(r.eligibility_url ?? r.final_url ?? r.url ?? "").trim(),
    }))
    .filter((r) => r.university && r.url);
}

// Scholarship URLs from the SEPARATE scholarship export, keyed for merging into
// the Aliff input (university_scholarship_url / course_scholarship_url).
interface SchData { uni: Map<string, string[]>; course: { uni: string; url: string }[] }
function readScholarships(): SchData {
  const data: SchData = { uni: new Map(), course: [] };
  const path = join(EXPORT_DIR, "scholarships-INTERNATIONAL-FINAL.csv");
  if (!existsSync(path)) return data;
  const wb = readWorkbook(path);
  const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { defval: "" });
  for (const r of rows) {
    const uni = String(r.university ?? "").trim();
    const url = String(r.scholarship_url ?? r.url ?? "").trim();
    if (!uni || !url) continue;
    const key = uni.toLowerCase();
    if (String(r.level ?? "").trim() === "course") data.course.push({ uni: key, url });
    else { const a = data.uni.get(key) ?? []; a.push(url); data.uni.set(key, a); }
  }
  return data;
}

function readBaseUrls(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(REF_CSV)) return map;
  const wb = readWorkbook(REF_CSV);
  const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { defval: "" });
  for (const r of rows) {
    const name = String(r.name ?? r.university_name ?? "").trim().toLowerCase();
    const base = String(r.base_url ?? "").trim();
    if (name && base) map.set(name, base);
  }
  return map;
}

const ABBR: Record<string, string> = { bsc: "BSc", ba: "BA", beng: "BEng", bba: "BBA", llb: "LLB", bs: "BS", msc: "MSc", ma: "MA", mba: "MBA", phd: "PhD", meng: "MEng" };

/** Best-effort course name from a URL slug. */
function deriveCourseName(url: string): string {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    // pick the most "course-like" segment (longest with letters), skipping generic ones
    const skip = new Set(["courses", "course", "programmes", "programs", "program", "study", "undergraduate", "degrees", "entry", "requirements", "admissions", "international"]);
    const cand = [...segs].reverse().find((s) => /[a-z]{4,}/i.test(s) && !skip.has(s.toLowerCase())) ?? segs[segs.length - 1] ?? "";
    const cleaned = cand
      .replace(/\.(html?|php|aspx)$/i, "")
      .replace(/^\d+[-_]?/, "") // leading id
      .replace(/[-_]+/g, " ")
      .trim();
    return cleaned
      .split(" ")
      .map((w) => ABBR[w.toLowerCase()] ?? (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ")
      .trim();
  } catch {
    return "";
  }
}

function deriveDegreeLevel(url: string): string {
  const u = url.toLowerCase();
  if (/(bachelor|-bsc|-ba\b|-beng|-bba|-llb|\bug\b|undergraduate)/.test(u)) return "Bachelor";
  if (/(master|-msc|-ma\b|-mba|-meng|postgraduate|\bpg\b)/.test(u)) return "Master";
  if (/(phd|doctor)/.test(u)) return "PhD";
  return "";
}

const COLUMNS = [
  "university_name", "country", "base_url",
  "university_eligibility_url", "university_scholarship_url", "university_fee_url", "brochure_link", "university_logo",
  "course_name", "degree_level", "campus", "course_category", "course_url", "course_eligibility_url",
  "course_scholarship_url", "course_fee_url", "additional_information_link", "notes",
] as const;
type Row = Partial<Record<(typeof COLUMNS)[number], string>>;

function buildRows(valid: ValidRow[], baseUrls: Map<string, string>, sch: SchData): Row[] {
  const out: Row[] = [];

  // University rows: one per university, joining its university-level eligibility
  // URLs + its university-level SCHOLARSHIP URLs (separate column).
  const byUni = new Map<string, ValidRow[]>();
  for (const r of valid) (byUni.get(r.university) ?? byUni.set(r.university, []).get(r.university)!).push(r);

  for (const [uni, rows] of byUni) {
    const uniUrls = [...new Set(rows.filter((r) => r.level === "university").map((r) => r.url))];
    if (uniUrls.length) {
      const uniSch = [...new Set(sch.uni.get(uni.toLowerCase()) ?? [])];
      out.push({
        university_name: uni,
        country: rows[0]?.country ?? "",
        base_url: baseUrls.get(uni.toLowerCase()) ?? "",
        university_eligibility_url: uniUrls.join("\n"),
        university_scholarship_url: uniSch.join("\n"),
        notes: "Auto-generated from verified crawl (university-level eligibility + scholarship).",
      });
    }
  }

  // Course rows: one per course-level URL. Attach any course-level scholarship
  // URL that lives under this course's path (best-effort), kept in its own column.
  for (const r of valid) {
    if (r.level !== "course") continue;
    const name = r.course_name || deriveCourseName(r.url);
    const stem = r.url.replace(/[#?].*$/, "").replace(/\.(html?|php|aspx)$/i, "").replace(/\/$/, "").toLowerCase();
    const courseSch = [...new Set(
      sch.course.filter((s) => s.uni === r.university.toLowerCase() && s.url.replace(/[#?].*$/, "").toLowerCase().startsWith(stem)).map((s) => s.url),
    )];
    out.push({
      university_name: r.university,
      country: r.country,
      base_url: baseUrls.get(r.university.toLowerCase()) ?? "",
      course_name: name,
      degree_level: deriveDegreeLevel(r.url),
      course_url: r.url,
      course_eligibility_url: r.url,
      course_scholarship_url: courseSch.join("\n"),
      notes: "Course name from page title / cleaned URL.",
    });
  }
  return out;
}

async function writeXlsx(path: string, rows: Row[]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("aliff-input", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c, key: c, width: c.includes("url") || c.includes("link") ? 60 : 22 }));
  for (const r of rows) ws.addRow(r);
  ws.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(path);
}

function writeCsv(path: string, rows: Row[]): void {
  const cell = (v: string | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [COLUMNS.map(cell).join(",")];
  for (const r of rows) lines.push(COLUMNS.map((c) => cell(r[c])).join(","));
  writeFileSync(path, lines.join("\r\n"), "utf8");
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const baseUrls = readBaseUrls();
  const scholarships = readScholarships();

  // SEPARATE inputs — University Eligibility and Course Eligibility must NEVER be
  // mixed (Aliff rule): each comes from its own validated file and writes its own
  // Aliff input (universities -> Manage Universities, courses -> Manage Courses).
  const uniValid = readValidUrls("eligibility-UNIVERSITY-INTERNATIONAL-FINAL.csv");
  const courseValid = readValidUrls("eligibility-COURSES-INTERNATIONAL-FINAL.csv");

  const uniRows = buildRows(uniValid, baseUrls, scholarships); // university-level rows only
  const courseRows = buildRows(courseValid, baseUrls, scholarships); // course-level rows only

  await writeXlsx(join(OUT_DIR, "aliff-input-universities-international.xlsx"), uniRows);
  writeCsv(join(OUT_DIR, "aliff-input-universities-international.csv"), uniRows);
  await writeXlsx(join(OUT_DIR, "aliff-input-courses-international.xlsx"), courseRows);
  writeCsv(join(OUT_DIR, "aliff-input-courses-international.csv"), courseRows);

  console.log(`UNIVERSITIES -> rows=${uniRows.length} (from ${uniValid.length} urls) | data/aliff-input-universities-international.{xlsx,csv}`);
  console.log(`COURSES      -> rows=${courseRows.length} (from ${courseValid.length} urls) | data/aliff-input-courses-international.{xlsx,csv}`);
}

main().catch((e) => {
  console.error("TRANSFORM_ERROR", e);
  process.exit(1);
});
