import type { Page } from "playwright";
import { config, selectors } from "./config.js";
import { fillField, fillChips, saveAndConfirm, selectDropdown, readField, clickFirst, firstVisible } from "./locator.js";
import type { UniversityRecord } from "./read-excel.js";
import type { Reporter, Action, Status } from "./reports.js";

export interface ProcessResult {
  action: Action;
  status: Status;
  reason: string;
  oldValue: string;
  newValue: string;
  screenshot: string;
}

export async function navigateToUniversities(page: Page): Promise<void> {
  // Navigate by URL — a clean reset every iteration (sidebar clicks get stuck on
  // a dirty/unsaved form left over from the previous DRY_RUN row).
  await page.goto(`${config.baseUrl}/manage-universities/university`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function searchExisting(page: Page, name: string): Promise<boolean> {
  const box = await firstVisible(page, selectors.list.searchBox, 5000);
  if (box) {
    await box.fill("");
    await box.fill(name);
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  // Heuristic: a result row containing the (case-insensitive) name.
  const match = page.getByText(name, { exact: false }).first();
  return await match.isVisible().catch(() => false);
}

/**
 * Process one university: search -> edit/add -> fill ONLY university-level fields
 * (never course eligibility) -> dry-run screenshot+log OR commit save.
 */
export async function processUniversity(page: Page, rec: UniversityRecord, reporter: Reporter): Promise<ProcessResult> {
  await navigateToUniversities(page);
  const found = await searchExisting(page, rec.university_name);

  let action: Action;
  if (found) {
    const opened = await clickFirst(page, selectors.list.editInRow, 6000);
    if (!opened) {
      const shot = await reporter.screenshot(page, `uni-edit-notfound-${rec.university_name}`);
      return { action: "manual-review", status: "needs-review", reason: "Found in list but could not open Edit", oldValue: "", newValue: "", screenshot: shot };
    }
    action = "update";
  } else {
    const added = await clickFirst(page, selectors.list.addUniversity, 6000);
    if (!added) {
      const shot = await reporter.screenshot(page, `uni-add-missing-${rec.university_name}`);
      return { action: "manual-review", status: "needs-review", reason: "Not found and Add University button not located", oldValue: "", newValue: "", screenshot: shot };
    }
    action = "create";
  }
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  // Fill ONLY university-level fields. Respect OVERWRITE for existing values.
  const f = selectors.universityForm;
  const filledNew: string[] = [];
  const setField = async (specs: string[], value: string | undefined, labelForLog: string) => {
    if (!value) return;
    const current = await readField(page, specs);
    if (current && !config.overwrite) return; // don't overwrite non-empty unless OVERWRITE
    const ok = await fillField(page, specs, value);
    if (ok) filledNew.push(`${labelForLog}=${value}`);
  };
  // Chip/tag inputs (URL link fields) — must press Enter to COMMIT each value,
  // else it's discarded on save.
  const setChips = async (specs: string[], value: string | undefined, labelForLog: string) => {
    if (!value) return;
    if (await fillChips(page, specs, value)) filledNew.push(`${labelForLog}=${value}`);
  };

  await setField(f.name, rec.university_name, "name");
  await setField(f.country, rec.country, "country");
  // CRITICAL: only UNIVERSITY eligibility goes here (chip field → commit w/ Enter).
  await setChips(f.eligibility, rec.university_eligibility_url, "uni_eligibility");
  await setChips(f.scholarship, rec.university_scholarship_url, "uni_scholarship");
  await setChips(f.fee, rec.university_fee_url, "uni_fee");
  await setField(f.brochure, rec.brochure_link, "brochure");
  await setField(f.notes, rec.notes, "notes");

  // CREATE requires Country (a combobox on the Location tab). Updates already
  // have it, so only set it when creating a brand-new university.
  if (action === "create" && rec.country) {
    await clickFirst(page, f.locationTab, 4000);
    await page.waitForTimeout(500);
    const cs = await selectDropdown(page, f.country, rec.country);
    if (cs === "not-found") {
      const shot = await reporter.screenshot(page, `uni-create-country-${rec.university_name}`);
      return { action: "manual-review", status: "needs-review", reason: `Required Country "${rec.country}" not in dropdown — cannot create`, oldValue: "", newValue: filledNew.join(" | "), screenshot: shot };
    }
    filledNew.push(`country(${cs})=${rec.country}`);
  }

  const newValue = filledNew.join(" | ");

  if (config.dryRun) {
    const shot = await reporter.screenshot(page, `DRYRUN-uni-${action}-${rec.university_name}`);
    return { action: "dry-run", status: "planned", reason: `Planned ${action} (no save in dry run)`, oldValue: "", newValue, screenshot: shot };
  }

  // Commit: save AND confirm it persisted (a click alone is NOT proof — the form
  // stays on /form with a validation error if something's wrong).
  const result = await saveAndConfirm(page, f.save);
  const shot = await reporter.screenshot(page, `uni-${action}-${result}-${rec.university_name}`);
  if (result === "no-button") {
    return { action: "failed", status: "failed", reason: "Save button not found", oldValue: "", newValue, screenshot: shot };
  }
  if (result === "not-confirmed") {
    return { action: "manual-review", status: "needs-review", reason: `Clicked ${action} but save NOT confirmed (still on form — likely a required field/validation)`, oldValue: "", newValue, screenshot: shot };
  }
  return { action, status: "success", reason: `${action} saved & confirmed`, oldValue: "", newValue, screenshot: shot };
}
