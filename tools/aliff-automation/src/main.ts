import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { config, assertCredentials } from "./config.js";
import { readInput, type UniversityRecord, type CourseRecord } from "./read-excel.js";
import { login } from "./login.js";
import { processUniversity, type ProcessResult } from "./university-automation.js";
import { processCourse } from "./course-automation.js";
import { Reporter, loadProgress, saveProgress, type Progress } from "./reports.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withRetry(fn: () => Promise<ProcessResult>, retries: number): Promise<ProcessResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1500);
    }
  }
  return {
    action: "failed",
    status: "failed",
    reason: `Errored after ${retries + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    oldValue: "",
    newValue: "",
    screenshot: "",
  };
}

/** Read an input file, or exit with a clear, non-technical message if it's missing. */
function readInputOrExit(file: string, label: string) {
  if (!existsSync(file)) {
    console.error(
      `\nINPUT NOT FOUND: the ${label} input file was not generated yet.\n` +
        `Expected: ${file}\n` +
        `Fix: on the Operations page run Step 1 (Validate & export links) then ` +
        `Step 2 (Build Aliff input files), then try this step again.\n`,
    );
    process.exit(2);
  }
  return readInput(file);
}

async function main() {
  assertCredentials();
  const limit = config.limit > 0 ? config.limit : Infinity;

  const wantUni = config.process !== "courses";
  const wantCourse = config.process !== "universities";

  let universities: UniversityRecord[] = [];
  let courses: CourseRecord[] = [];

  if (config.inputFile) {
    // A single combined file was supplied — use it for whatever is requested.
    const input = readInputOrExit(config.inputFile, "combined");
    universities = wantUni ? input.universities : [];
    courses = wantCourse ? input.courses : [];
  } else {
    // Default: read the two files produced by "Build Aliff input files".
    if (wantUni) universities = readInputOrExit(config.inputUniversitiesFile, "universities").universities;
    if (wantCourse) courses = readInputOrExit(config.inputCoursesFile, "courses").courses;
  }

  universities = universities.slice(0, limit);
  courses = courses.slice(0, limit);

  console.log(
    `Input: ${universities.length} universities, ${courses.length} courses (process=${config.process})`,
  );
  console.log(
    `Run: DRY_RUN=${config.dryRun} OVERWRITE=${config.overwrite} PROCESS=${config.process} LIMIT=${config.limit || "all"} -> processing ${universities.length} universities + ${courses.length} courses`,
  );
  if (config.dryRun) console.log("DRY RUN — will NOT click final Save. Fills + screenshots + logs only.\n");

  const reporter = new Reporter();
  const progress: Progress = loadProgress();
  let processed = 0;

  const browser: Browser = await chromium.launch({ headless: config.headless, args: ["--no-sandbox"] });
  const page: Page = await browser.newPage();

  try {
    await login(page);
    console.log("Logged in.\n");

    // ---- Universities ----
    for (const uni of universities) {
      const key = uni.university_name.toLowerCase();
      if (!config.dryRun && progress.completedUniversities.includes(key)) continue; // resume
      const res = await withRetry(() => processUniversity(page, uni, reporter), config.retries);
      reporter.add({
        row_number: uni.rowNumber,
        record_type: "university",
        university_name: uni.university_name,
        course_name: "",
        action: res.action,
        status: res.status,
        reason: res.reason,
        old_value: res.oldValue,
        new_value: res.newValue,
        screenshot_path: res.screenshot,
      });
      console.log(`[uni] ${uni.university_name} -> ${res.action}/${res.status} ${res.reason}`);
      if (!config.dryRun && (res.status === "success" || res.action === "skip-duplicate")) progress.completedUniversities.push(key);
      if (++processed % config.checkpointEvery === 0) {
        await reporter.flush();
        if (!config.dryRun) saveProgress(progress);
        console.log(`  -- checkpoint (${processed} processed) --`);
      }
    }

    // ---- Courses ----
    for (const course of courses) {
      const key = `${course.university_name}||${course.course_name}`.toLowerCase();
      if (!config.dryRun && progress.completedCourses.includes(key)) continue; // resume
      const res = await withRetry(() => processCourse(page, course, reporter), config.retries);
      reporter.add({
        row_number: course.rowNumber,
        record_type: "course",
        university_name: course.university_name,
        course_name: course.course_name,
        action: res.action,
        status: res.status,
        reason: res.reason,
        old_value: res.oldValue,
        new_value: res.newValue,
        screenshot_path: res.screenshot,
      });
      console.log(`[course] ${course.course_name} @ ${course.university_name} -> ${res.action}/${res.status} ${res.reason}`);
      if (!config.dryRun && (res.status === "success" || res.action === "skip-duplicate")) progress.completedCourses.push(key);
      if (++processed % config.checkpointEvery === 0) {
        await reporter.flush();
        if (!config.dryRun) saveProgress(progress);
        console.log(`  -- checkpoint (${processed} processed) --`);
      }
    }
  } finally {
    await reporter.flush();
    if (!config.dryRun) saveProgress(progress);
    await browser.close();
  }

  const s = reporter.summary();
  console.log("\n===== SUMMARY =====");
  console.log(`Universities processed: ${s.universitiesProcessed}  (created ${s.universitiesCreated}, updated ${s.universitiesUpdated})`);
  console.log(`Courses processed:      ${s.coursesProcessed}  (created ${s.coursesCreated}, updated ${s.coursesUpdated})`);
  console.log(`Skipped duplicates:     ${s.skippedDuplicates}`);
  console.log(`Failed rows:            ${s.failed}`);
  console.log(`Manual review rows:     ${s.manualReview}`);
  console.log(`Reports: tools/aliff-automation/reports/  Screenshots: tools/aliff-automation/screenshots/`);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
