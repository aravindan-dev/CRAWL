import type { Page } from "playwright";
import { config, selectors } from "./config.js";
import { fillField, fillChips, saveAndConfirm, readField, clickFirst, firstVisible, selectDropdown } from "./locator.js";
import type { CourseRecord } from "./read-excel.js";
import type { Reporter } from "./reports.js";
import type { ProcessResult } from "./university-automation.js";

export async function navigateToCourses(page: Page): Promise<void> {
  // Courses list lives at /course (not /manage-courses/...). Navigate by URL for
  // a clean reset each row (avoids getting stuck on a prior unsaved form).
  await page.goto(`${config.baseUrl}/course`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
}

/** Returns true if a row matching BOTH course name and university is visible. */
async function findCourse(page: Page, courseName: string, uniName: string): Promise<boolean> {
  const box = await firstVisible(page, selectors.list.searchBox, 5000);
  if (box) {
    await box.fill("");
    await box.fill(courseName);
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  // Require both the course name AND the university name to appear (dup guard).
  const courseVisible = await page.getByText(courseName, { exact: false }).first().isVisible().catch(() => false);
  const uniVisible = await page.getByText(uniName, { exact: false }).first().isVisible().catch(() => false);
  return courseVisible && uniVisible;
}

/**
 * Process one course: search by name + verify university match -> edit/add ->
 * fill ONLY course-level fields (never the university eligibility link) ->
 * dry-run screenshot+log OR commit save. Dropdown (University, Level) is matched
 * exact then normalized; if unresolved -> manual review (never a wrong value).
 */
export async function processCourse(page: Page, rec: CourseRecord, reporter: Reporter): Promise<ProcessResult> {
  await navigateToCourses(page);
  const found = await findCourse(page, rec.course_name, rec.university_name);

  let action: ProcessResult["action"];
  if (found) {
    const opened = await clickFirst(page, selectors.list.editInRow, 6000);
    if (!opened) {
      const shot = await reporter.screenshot(page, `course-edit-notfound-${rec.course_name}`);
      return { action: "manual-review", status: "needs-review", reason: "Course+university match found but Edit not opened", oldValue: "", newValue: "", screenshot: shot };
    }
    action = "update";
  } else {
    const added = await clickFirst(page, selectors.list.addCourse, 6000);
    if (!added) {
      const shot = await reporter.screenshot(page, `course-add-missing-${rec.course_name}`);
      return { action: "manual-review", status: "needs-review", reason: "Not found and Add Course button not located", oldValue: "", newValue: "", screenshot: shot };
    }
    action = "create";
  }
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  const f = selectors.courseForm;
  const filledNew: string[] = [];
  const setField = async (specs: string[], value: string | undefined, label: string) => {
    if (!value) return;
    const current = await readField(page, specs);
    if (current && !config.overwrite) return;
    if (await fillField(page, specs, value)) filledNew.push(`${label}=${value}`);
  };
  // Chip/tag inputs (URL link fields) — press Enter to COMMIT each, else dropped on save.
  const setChips = async (specs: string[], value: string | undefined, label: string) => {
    if (!value) return;
    if (await fillChips(page, specs, value)) filledNew.push(`${label}=${value}`);
  };

  await setField(f.name, rec.course_name, "course_name");

  // University dropdown — must resolve correctly or bail to manual review.
  const uniMatch = await selectDropdown(page, f.university, rec.university_name);
  if (uniMatch === "not-found") {
    const shot = await reporter.screenshot(page, `course-uni-dropdown-${rec.course_name}`);
    return { action: "manual-review", status: "needs-review", reason: `University "${rec.university_name}" not in dropdown`, oldValue: "", newValue: filledNew.join(" | "), screenshot: shot };
  }
  filledNew.push(`university(${uniMatch})=${rec.university_name}`);

  // Degree level — exact/normalized or manual review (never a wrong value).
  if (rec.degree_level) {
    const lvl = await selectDropdown(page, f.degreeLevel, rec.degree_level);
    if (lvl === "not-found") {
      const shot = await reporter.screenshot(page, `course-level-dropdown-${rec.course_name}`);
      return { action: "manual-review", status: "needs-review", reason: `Degree level "${rec.degree_level}" not in dropdown`, oldValue: "", newValue: filledNew.join(" | "), screenshot: shot };
    }
    filledNew.push(`level(${lvl})=${rec.degree_level}`);
  }
  if (rec.course_category) await selectDropdown(page, f.category, rec.course_category);

  await setField(f.campus, rec.campus, "campus");
  await setChips(f.courseUrl, rec.additional_information_link || rec.course_url, "course_url");
  // CRITICAL: only COURSE eligibility goes here — never the university link.
  await setChips(f.eligibility, rec.course_eligibility_url, "course_eligibility");
  await setChips(f.scholarship, rec.course_scholarship_url, "course_scholarship");
  await setChips(f.fee, rec.course_fee_url, "course_fee");

  const newValue = filledNew.join(" | ");

  if (config.dryRun) {
    const shot = await reporter.screenshot(page, `DRYRUN-course-${action}-${rec.course_name}`);
    return { action: "dry-run", status: "planned", reason: `Planned ${action} (no save in dry run)`, oldValue: "", newValue, screenshot: shot };
  }

  // Commit + CONFIRM persistence (a click alone is not proof).
  const result = await saveAndConfirm(page, f.save);
  const shot = await reporter.screenshot(page, `course-${action}-${result}-${rec.course_name}`);
  if (result === "no-button") return { action: "failed", status: "failed", reason: "Save button not found", oldValue: "", newValue, screenshot: shot };
  if (result === "not-confirmed") {
    return { action: "manual-review", status: "needs-review", reason: `Clicked ${action} but save NOT confirmed (still on form — likely a required field/validation)`, oldValue: "", newValue, screenshot: shot };
  }
  return { action, status: "success", reason: `${action} saved & confirmed`, oldValue: "", newValue, screenshot: shot };
}
