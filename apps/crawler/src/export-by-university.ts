/**
 * Per-university (and combined) export — runs AFTER Revalidate.
 *
 * Reads the validated FINAL workbooks (university + course) and writes:
 *   • storage/exports/by-university/<University>__<localstamp>.csv (+ .xlsx)
 *       one SEPARATE file per university (its university-level + course rows)
 *   • storage/exports/eligibility-ALL-INTERNATIONAL_<localstamp>.xlsx (+ .csv)
 *       one COMPLETE file with every university + every level (the "full" export)
 *
 * Every file carries an `exported_at` column and a filename stamp in the
 * machine's LOCAL time (user choice). The canonical *-FINAL files are NOT
 * touched — this is purely additive, so Aliff / Monitor / counts keep working.
 *
 * Run: tsx src/export-by-university.ts
 */
import { writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { repoRoot, codepointCompare } from "@clg/shared";

const DIR = join(repoRoot(), "storage", "exports");
const OUT = join(DIR, "by-university");

interface Row { university: string; country: string; level: string; course_name: string; url: string; http: string; validity: string }

/** Read the "Valid URLs" sheet of a FINAL workbook (same layout recheck.ts writes). */
async function readValid(file: string): Promise<Row[]> {
  const path = join(DIR, file);
  if (!existsSync(path)) return [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet("Valid URLs") ?? wb.worksheets[0];
  const rows: Row[] = [];
  ws?.eachRow((row, n) => {
    if (n === 1) return; // header
    const v = (i: number) => String(row.getCell(i).text ?? "").trim();
    const url = v(5);
    if (!url || !/^https?:\/\//i.test(url)) return;
    rows.push({ university: v(1), country: v(2), level: v(3), course_name: v(4), url, http: v(6), validity: v(7) });
  });
  return rows;
}

/** LOCAL-time stamp: a filename token + a human-readable local date/time (no UTC annotation). */
function nowStamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fileStamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const human = d.toLocaleString(); // local time, shown as-is — no "(UTC±hh:mm)" suffix
  return { fileStamp, human };
}

/** A filesystem-safe university name for the per-university filename. */
function safeName(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "university";
}

const HEAD = ["university", "country", "level", "course_name", "eligibility_url", "http_status", "validity", "exported_at"];
const csvCell = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
function toCsv(rows: Row[], exportedAt: string): string {
  const lines = [HEAD.map(csvCell).join(",")];
  for (const r of rows) lines.push([r.university, r.country, r.level, r.course_name, r.url, r.http, r.validity, exportedAt].map(csvCell).join(","));
  return lines.join("\r\n");
}

/** Add a styled URL worksheet (same columns as the FINAL files + Exported At). */
function addUrlSheet(wb: ExcelJS.Workbook, name: string, rows: Row[], exportedAt: string) {
  const ws = wb.addWorksheet(name.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "University", key: "university", width: 42 },
    { header: "Country", key: "country", width: 14 },
    { header: "Level", key: "level", width: 11 },
    { header: "Course Name", key: "course_name", width: 40 },
    { header: "Eligibility / Criteria URL", key: "url", width: 90 },
    { header: "HTTP", key: "http", width: 7 },
    { header: "Validity", key: "validity", width: 17 },
    { header: "Exported At", key: "exported_at", width: 26 },
  ];
  for (const r of rows) {
    const row = ws.addRow({ ...r, exported_at: exportedAt });
    const cell = row.getCell("url");
    cell.value = { text: r.url, hyperlink: r.url };
    cell.font = { color: { argb: "FF0563C1" }, underline: true };
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: "A1", to: "H1" };
  return ws;
}

async function main() {
  const [uni, course] = await Promise.all([
    readValid("eligibility-UNIVERSITY-INTERNATIONAL-FINAL.xlsx"),
    readValid("eligibility-COURSES-INTERNATIONAL-FINAL.xlsx"),
  ]);
  const all = [...uni, ...course];
  if (all.length === 0) {
    console.error("[by-university] No validated rows found — run Revalidate first (the *-FINAL files are missing/empty).");
    process.exit(1);
  }
  const { fileStamp, human } = nowStamp();

  // Group by university.
  const byUni = new Map<string, Row[]>();
  for (const r of all) (byUni.get(r.university) ?? byUni.set(r.university, []).get(r.university)!).push(r);
  const sortRows = (rows: Row[]) =>
    rows.sort((a, b) => (a.level === b.level ? codepointCompare(a.course_name, b.course_name) : a.level === "university" ? -1 : 1));

  // SEPARATE per-university files — clean the folder first so only the latest run remains.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  let perUniFiles = 0;
  for (const [name, rows] of [...byUni].sort((a, b) => codepointCompare(a[0], b[0]))) {
    sortRows(rows);
    const base = `${safeName(name)}__${fileStamp}`;
    writeFileSync(join(OUT, `${base}.csv`), toCsv(rows, human), "utf8");
    const wb = new ExcelJS.Workbook();
    addUrlSheet(wb, "URLs", rows, human);
    await wb.xlsx.writeFile(join(OUT, `${base}.xlsx`));
    perUniFiles += 2;
    console.log(`[by-university] ${name}: ${rows.length} URLs (${perUniFiles}/${byUni.size * 2})`);
  }

  // COMPLETE combined file (all universities + all levels) — drop old stamped copies first.
  for (const f of readdirSync(DIR)) if (/^eligibility-ALL-INTERNATIONAL_.*\.(xlsx|csv)$/i.test(f)) rmSync(join(DIR, f), { force: true });
  sortRows(all);
  writeFileSync(join(DIR, `eligibility-ALL-INTERNATIONAL_${fileStamp}.csv`), toCsv(all, human), "utf8");

  const wbAll = new ExcelJS.Workbook();
  const sum = wbAll.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  sum.columns = [
    { header: "University", key: "u", width: 44 },
    { header: "Country", key: "c", width: 16 },
    { header: "University URLs", key: "uni", width: 15 },
    { header: "Course URLs", key: "course", width: 13 },
    { header: "Total", key: "total", width: 10 },
  ];
  for (const [name, rows] of [...byUni].sort((a, b) => codepointCompare(a[0], b[0]))) {
    sum.addRow({ u: name, c: rows[0]?.country ?? "", uni: rows.filter((r) => r.level === "university").length, course: rows.filter((r) => r.level === "course").length, total: rows.length });
  }
  sum.addRow({});
  sum.addRow({ u: "TOTAL", c: `${byUni.size} universities`, uni: all.filter((r) => r.level === "university").length, course: all.filter((r) => r.level === "course").length, total: all.length });
  sum.addRow({});
  sum.addRow({ u: "Exported at (local)", c: human });
  sum.getRow(1).font = { bold: true };
  addUrlSheet(wbAll, "All URLs", all, human);
  await wbAll.xlsx.writeFile(join(DIR, `eligibility-ALL-INTERNATIONAL_${fileStamp}.xlsx`));

  console.log(`[by-university] WROTE ${perUniFiles} per-university files for ${byUni.size} universities + 1 combined ALL workbook (exported_at = ${human})`);
  process.exit(0);
}

main().catch((e) => {
  console.error("BY_UNIVERSITY_ERROR", e);
  process.exit(1);
});
