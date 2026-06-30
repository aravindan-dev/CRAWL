import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import type { Page } from "playwright";

const ROOT = join(process.cwd());
const DIRS = {
  reports: join(ROOT, "reports"),
  screenshots: join(ROOT, "screenshots"),
};
for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });

export type Action = "create" | "update" | "skip-duplicate" | "skip-existing" | "manual-review" | "failed" | "dry-run";
export type Status = "success" | "planned" | "skipped" | "failed" | "needs-review";

export interface LogEntry {
  row_number: number;
  record_type: "university" | "course";
  university_name: string;
  course_name: string;
  action: Action;
  status: Status;
  reason: string;
  old_value: string;
  new_value: string;
  screenshot_path: string;
  timestamp: string;
}

const LOG_COLUMNS = [
  "row_number",
  "record_type",
  "university_name",
  "course_name",
  "action",
  "status",
  "reason",
  "old_value",
  "new_value",
  "screenshot_path",
  "timestamp",
] as const;

export interface Progress {
  completedUniversities: string[]; // lowercased names
  completedCourses: string[]; // `${uni}||${course}` lowercased
  lastUpdated: string;
}

const PROGRESS_FILE = join(ROOT, "automation-progress.json");

export function loadProgress(): Progress {
  if (existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(readFileSync(PROGRESS_FILE, "utf8")) as Progress;
    } catch {
      /* fall through */
    }
  }
  return { completedUniversities: [], completedCourses: [], lastUpdated: new Date().toISOString() };
}

export function saveProgress(p: Progress): void {
  p.lastUpdated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2), "utf8");
}

export class Reporter {
  private entries: LogEntry[] = [];

  add(entry: Omit<LogEntry, "timestamp">): void {
    this.entries.push({ ...entry, timestamp: new Date().toISOString() });
  }

  async screenshot(page: Page, name: string): Promise<string> {
    const safe = name.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 80);
    const file = join(DIRS.screenshots, `${Date.now()}_${safe}.png`);
    try {
      await page.screenshot({ path: file, fullPage: true });
      return file;
    } catch {
      return "";
    }
  }

  private async writeSheet(path: string, rows: LogEntry[]): Promise<void> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("log", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = LOG_COLUMNS.map((c) => ({ header: c, key: c, width: c.includes("name") || c.includes("value") || c.includes("path") ? 40 : 16 }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
    await wb.xlsx.writeFile(path);
  }

  /** Write all three report workbooks. Safe to call repeatedly (checkpoints). */
  async flush(): Promise<void> {
    await this.writeSheet(join(DIRS.reports, "automation-log.xlsx"), this.entries);
    await this.writeSheet(
      join(DIRS.reports, "failed-records.xlsx"),
      this.entries.filter((e) => e.status === "failed"),
    );
    await this.writeSheet(
      join(DIRS.reports, "manual-review.xlsx"),
      this.entries.filter((e) => e.status === "needs-review"),
    );
  }

  summary() {
    const count = (t: string, a?: Action, s?: Status) =>
      this.entries.filter((e) => e.record_type === t && (!a || e.action === a) && (!s || e.status === s)).length;
    return {
      universitiesProcessed: this.entries.filter((e) => e.record_type === "university").length,
      universitiesCreated: count("university", "create"),
      universitiesUpdated: count("university", "update"),
      coursesProcessed: this.entries.filter((e) => e.record_type === "course").length,
      coursesCreated: count("course", "create"),
      coursesUpdated: count("course", "update"),
      skippedDuplicates: this.entries.filter((e) => e.action === "skip-duplicate").length,
      failed: this.entries.filter((e) => e.status === "failed").length,
      manualReview: this.entries.filter((e) => e.status === "needs-review").length,
    };
  }
}
