import { format as formatCsv } from "fast-csv";
import ExcelJS from "exceljs";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { repoRoot } from "@clg/shared";
import type { CourseCriteria } from "@clg/database";

/** Export column order (Section 36 — exact). */
export const EXPORT_COLUMNS = [
  "university_name",
  "course_name",
  "degree_level",
  "criteria",
  "criteria_url",
  "required_subjects",
  "minimum_marks",
  "entrance_exam",
  "english_requirement",
  "confidence_score",
  "review_status",
  "source_snippet",
  "created_at",
] as const;

function toRow(r: CourseCriteria): Record<string, string | number> {
  const subjects = Array.isArray(r.required_subjects)
    ? (r.required_subjects as string[]).join("; ")
    : String(r.required_subjects ?? "");
  return {
    university_name: r.university_name,
    course_name: r.course_name,
    degree_level: r.degree_level,
    criteria: r.criteria ?? "",
    criteria_url: r.criteria_url,
    required_subjects: subjects,
    minimum_marks: r.minimum_marks ?? "",
    entrance_exam: r.entrance_exam ?? "",
    english_requirement: r.english_requirement ?? "",
    confidence_score: r.confidence_score,
    review_status: r.review_status,
    source_snippet: r.source_snippet,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

async function ensureDir(filePath: string): Promise<string> {
  const full = resolve(repoRoot(), filePath);
  await mkdir(dirname(full), { recursive: true });
  return full;
}

export async function writeCsv(records: CourseCriteria[], filePath: string): Promise<string> {
  const full = await ensureDir(filePath);
  await new Promise<void>((resolvePromise, reject) => {
    const ws = createWriteStream(full);
    const csv = formatCsv({ headers: [...EXPORT_COLUMNS] });
    csv.pipe(ws);
    ws.on("finish", () => resolvePromise());
    ws.on("error", reject);
    for (const r of records) csv.write(toRow(r));
    csv.end();
  });
  return filePath;
}

export async function writeXlsx(records: CourseCriteria[], filePath: string): Promise<string> {
  const full = await ensureDir(filePath);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Course Criteria", {
    views: [{ state: "frozen", ySplit: 1 }], // frozen header
  });

  ws.columns = EXPORT_COLUMNS.map((key) => ({
    header: key,
    key,
    width: key === "criteria" || key === "source_snippet" ? 60 : key === "criteria_url" ? 50 : 20,
  }));

  for (const r of records) {
    const row = ws.addRow(toRow(r));
    // Clickable criteria_url hyperlink.
    const urlCell = row.getCell("criteria_url");
    const url = String(urlCell.value ?? "");
    if (url) urlCell.value = { text: url, hyperlink: url };
    urlCell.font = { color: { argb: "FF0563C1" }, underline: true };

    // Confidence formatting: red < 0.6, amber < 0.8, green otherwise.
    const conf = Number(r.confidence_score);
    const confCell = row.getCell("confidence_score");
    confCell.numFmt = "0.00";
    confCell.font = {
      color: { argb: conf < 0.6 ? "FFC00000" : conf < 0.8 ? "FFBF8F00" : "FF1E7B34" },
    };
  }

  ws.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(full);
  return filePath;
}
