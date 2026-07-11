import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { config, selectors } from "./config.js";
import { fillField, fillChips, saveAndConfirm, readField, clickFirst, firstVisible, namesMatch, normName } from "./locator.js";
import type { UniversityRecord } from "./read-excel.js";
import type { Reporter, Action, Status } from "./reports.js";

// Dump the current page HTML once per label — same debug aid as course-automation.
const _dumped = new Set<string>();
async function dumpDom(page: Page, label: string, force = false): Promise<void> {
  if ((!config.debugDom && !force) || _dumped.has(label)) return;
  _dumped.add(label);
  try {
    const html = await page.content();
    const file = join(process.cwd(), "screenshots", `DOM-${label}-${Date.now()}.html`);
    writeFileSync(file, html, "utf8");
    console.log(`[debug] dumped DOM → ${file}`);
  } catch {
    /* best-effort */
  }
}

export interface ProcessResult {
  action: Action;
  status: Status;
  reason: string;
  oldValue: string;
  newValue: string;
  screenshot: string;
}

/**
 * Reduce a possibly multi-line / comma-separated URL cell to the SINGLE first
 * link. The university-eligibility field must carry exactly one link (the one we
 * found for this university), never the full list. "" when there is none.
 */
function firstLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  for (const line of value.split(/\r?\n/)) {
    for (const part of line.split(",")) {
      const t = part.trim();
      if (t) return t;
    }
  }
  return undefined;
}

export async function navigateToUniversities(page: Page): Promise<void> {
  // Navigate by URL — a clean reset every iteration (sidebar clicks get stuck on
  // a dirty/unsaved form left over from the previous DRY_RUN row).
  await page.goto(`${config.baseUrl}/manage-universities/university`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
}

/** All distinct URLs on the input record — used to disambiguate same-named rows. */
function urlHints(rec: UniversityRecord): string[] {
  const urls = new Set<string>();
  for (const u of [rec.base_url, rec.university_eligibility_url, rec.university_scholarship_url, rec.university_fee_url, rec.brochure_link]) {
    if (u) for (const line of u.split(/\r?\n/)) { const t = line.trim(); if (t) urls.add(t); }
  }
  return [...urls];
}

/**
 * Distinctive path/host tokens pulled from the input URLs — same logic as
 * course-automation.ts's version. For universities the domain itself is often
 * the distinguishing signal (e.g. "york.ac.uk" vs "yorku.ca" for two
 * differently-named-but-similar institutions), so the HOST is included as a
 * token source alongside the path, unlike the course version which only reads
 * the path.
 */
function urlDistinctTokens(urls: string[], universityName: string): string[] {
  const GENERIC = new Set([
    "http", "https", "www", "com", "edu", "org", "ac", "index", "html", "htm", "php", "aspx",
    "university", "college", "institute", "en", "uk", "us", "au", "ca", "nz",
  ]);
  const nameWords = new Set(universityName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
  const tokens = new Set<string>();
  for (const u of urls) {
    let host = "";
    let path = u;
    try {
      const parsed = new URL(u);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch { /* keep raw path */ }
    for (const seg of `${host} ${path}`.toLowerCase().split(/[^a-z0-9]+/)) {
      if (seg.length >= 3 && !GENERIC.has(seg) && !nameWords.has(seg)) tokens.add(seg);
    }
  }
  return [...tokens];
}

/**
 * Unique resume/progress key for a university row. Includes the URL's
 * distinctive tokens (or row number) so two DIFFERENT universities that
 * happen to share a name are never collapsed into one progress entry — same
 * rationale as courseProgressKey in course-automation.ts.
 */
export function universityProgressKey(rec: UniversityRecord): string {
  const tokens = urlDistinctTokens(urlHints(rec), rec.university_name).sort().join("-");
  const suffix = tokens || `row${rec.rowNumber}`;
  return `${rec.university_name}||${suffix}`.toLowerCase();
}

interface RowCandidate {
  pageNum: number;
  indexOnPage: number;
  text: string;
  hrefs: string;
}

type FindResult =
  | { kind: "found"; row: Locator }
  | { kind: "not-found"; diagnostic: string };

/**
 * Locate a university across ALL pages of the list (never just page 1),
 * scoring every candidate row against the input's URL tokens over the WHOLE
 * result set at once — not page-by-page — so two same-named universities that
 * land on different pages are compared against each other rather than each
 * winning by default on whichever page happens to render first. Mirrors
 * course-automation.ts's findCourseRow/pickBestCandidate exactly.
 */
async function findUniversityRow(page: Page, rec: UniversityRecord): Promise<FindResult> {
  const name = rec.university_name;
  const box = await firstVisible(page, selectors.list.searchBox, 5000);
  if (box) {
    await box.fill("");
    await box.fill(name);
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  const hintUrls = urlHints(rec);
  const tokens = urlDistinctTokens(hintUrls, name);
  const candidates: RowCandidate[] = [];
  let pagesSearched = 0;
  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    pagesSearched = pageNum;
    const rows = page.getByRole("row").filter({ hasText: name });
    const count = await rows.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const text = (await row.innerText().catch(() => "")).toLowerCase();
      const hrefs = (await row.locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href)).catch(() => [])).join(" ").toLowerCase();
      candidates.push({ pageNum, indexOnPage: i, text, hrefs });
    }

    const nextBtn = await firstVisible(page, [
      "css:a[aria-label='Go to next page']",
      "role:link|Go to next page",
      "role:link|Next",
      "role:button|Next",
    ], 2000);
    const isDisabled = nextBtn ? await nextBtn.getAttribute("aria-disabled").then((d) => d === "true").catch(() => false) : true;
    if (nextBtn && !isDisabled) {
      await nextBtn.click();
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
    } else {
      break;
    }
  }

  if (candidates.length === 0) {
    await dumpDom(page, `uni-not-found-${normName(name)}`, true);
    return { kind: "not-found", diagnostic: `${pagesSearched} page(s) searched; no row contained "${name}" — the search box may not have applied as expected` };
  }

  const winner = pickBestCandidate(candidates, name, tokens);
  if (!winner) {
    await dumpDom(page, `uni-not-found-${normName(name)}`, true);
    return { kind: "not-found", diagnostic: `${pagesSearched} page(s) searched; ${candidates.length} candidate row(s) found but URL tokens [${tokens.join(", ") || "none"}] did not uniquely confirm any of them (ambiguous — multiple same-named universities?) — refused to guess` };
  }

  const row = await goToCandidateRow(page, name, winner);
  if (!row) {
    await dumpDom(page, `uni-relocate-failed-${normName(name)}`, true);
    return { kind: "not-found", diagnostic: `Matched a candidate on page ${winner.pageNum} but could not re-locate it after navigating back to that page` };
  }
  return { kind: "found", row };
}

async function goToCandidateRow(page: Page, name: string, winner: RowCandidate): Promise<Locator | null> {
  const box = await firstVisible(page, selectors.list.searchBox, 5000);
  if (box) {
    await box.fill("");
    await box.fill(name);
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  for (let p = 1; p < winner.pageNum; p++) {
    const nextBtn = await firstVisible(page, [
      "css:a[aria-label='Go to next page']",
      "role:link|Go to next page",
      "role:link|Next",
      "role:button|Next",
    ], 2000);
    if (!nextBtn) return null;
    await nextBtn.click();
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  const rows = page.getByRole("row").filter({ hasText: name });
  const row = rows.nth(winner.indexOnPage);
  return (await row.isVisible().catch(() => false)) ? row : null;
}

/**
 * Score every candidate across the WHOLE result set and pick the single best
 * match — exact name match wins outright when unambiguous; otherwise the
 * candidate with the strictly-highest (and uniquely-highest) URL-token
 * overlap wins. Mirrors course-automation.ts's pickBestCandidate.
 */
function pickBestCandidate(candidates: RowCandidate[], name: string, tokens: string[]): RowCandidate | null {
  if (candidates.length === 1) {
    const only = candidates[0]!;
    const firstLine = only.text.split("\n")[0] ?? only.text;
    if (normName(firstLine) === normName(name) || !tokens.length) return only;
  }

  if (!tokens.length) {
    return candidates.length === 1 ? candidates[0]! : null;
  }

  let best: RowCandidate | null = null;
  let bestScore = 0;
  let bestCount = 0;
  for (const c of candidates) {
    const hay = `${c.text} ${c.hrefs}`;
    const score = tokens.filter((t) => hay.includes(t)).length;
    if (score === 0) continue;
    if (score > bestScore) {
      bestScore = score;
      best = c;
      bestCount = 1;
    } else if (score === bestScore) {
      bestCount += 1;
    }
  }
  return bestScore > 0 && bestCount === 1 ? best : null;
}

/**
 * Process one university: search -> edit/add -> fill ONLY university-level fields
 * (never course eligibility) -> dry-run screenshot+log OR commit save.
 */
export async function processUniversity(page: Page, rec: UniversityRecord, reporter: Reporter): Promise<ProcessResult> {
  await navigateToUniversities(page);
  const found = await findUniversityRow(page, rec);
  const f = selectors.universityForm;

  // POLICY: never create a university. If it isn't already on Aliff, skip it —
  // same rule as courses (see course-automation.ts's processCourse).
  if (found.kind === "not-found") {
    const shot = await reporter.screenshot(page, `uni-not-found-${rec.university_name}`);
    return {
      action: "skip-not-found",
      status: "skipped",
      reason: `University "${rec.university_name}" not found on Aliff — skipped (never create a new university). ${found.diagnostic}`,
      oldValue: "",
      newValue: "",
      screenshot: shot,
    };
  }

  // Found → update only. Click Edit INSIDE the matched row (never the first Edit).
  const action: Action = "update";
  const opened = await clickFirst(found.row, selectors.list.editInRow, 6000);
  if (!opened) {
    const shot = await reporter.screenshot(page, `uni-edit-notfound-${rec.university_name}`);
    return { action: "manual-review", status: "needs-review", reason: "Found in list but could not open Edit", oldValue: "", newValue: "", screenshot: shot };
  }
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await dumpDom(page, "uni-edit-form");

  // UPDATE: prove the form shows THIS university before touching any field —
  // links must never be pasted into another university's record. Uses the SAME
  // exact-or-token-confirmed rule as row matching (never the lenient namesMatch
  // substring check) — see course-automation.ts's equivalent guard for why.
  {
    const formName = await readField(page, f.name);
    const formTokens = urlDistinctTokens(urlHints(rec), rec.university_name);
    const isExactName = !!formName && normName(formName) === normName(rec.university_name);
    const isTokenConfirmed = !!formName && formTokens.length > 0 && formTokens.some((t) => formName.toLowerCase().includes(t));
    if (!formName || !(isExactName || isTokenConfirmed)) {
      const shot = await reporter.screenshot(page, `uni-wrong-record-${rec.university_name}`);
      return { action: "manual-review", status: "needs-review", reason: `Edit form shows "${formName || "(empty)"}" but expected "${rec.university_name}" (URL tokens [${formTokens.join(", ") || "none"}] did not confirm it either) — wrong record, nothing filled`, oldValue: formName, newValue: "", screenshot: shot };
    }
  }

  // Fill ONLY university-level fields. Respect OVERWRITE for existing values.
  const filledNew: string[] = [];
  const warnings: string[] = [];
  // Any link/value that was in the input file but could NOT be placed in its
  // proper field lands here — such a record is never saved (manual review).
  const misplaced: string[] = [];
  const setField = async (specs: string[], value: string | undefined, labelForLog: string) => {
    if (!value) return;
    const current = await readField(page, specs);
    if (current && !config.overwrite) return; // intentional keep, not an error
    const ok = await fillField(page, specs, value);
    if (ok) filledNew.push(`${labelForLog}=${value}`);
    else misplaced.push(`${labelForLog}: field not found on the form`);
  };
  // Chip/tag inputs (URL link fields) — each chip is committed with Enter AND
  // verified; a link that didn't land in its field is a placement error.
  const setChips = async (specs: string[], value: string | undefined, labelForLog: string) => {
    if (!value) return;
    const res = await fillChips(page, specs, value);
    if (res.status === "no-field") {
      warnings.push(`${labelForLog}: field not found on the form (skipped)`);
      return;
    }
    if (res.failed.length) {
      const shown = res.failed.slice(0, 3).join(" ");
      warnings.push(`${labelForLog}: ${res.failed.length} link(s) did not commit as chips (${shown}${res.failed.length > 3 ? " …" : ""})`);
    }
    if (res.added > 0) filledNew.push(`${labelForLog}=+${res.added} link(s)`);
    else if (res.already > 0) filledNew.push(`${labelForLog}(already present)`);
  };

  await setField(f.name, rec.university_name, "name");
  await setField(f.country, rec.country, "country");
  // CRITICAL: only UNIVERSITY eligibility goes here, and ONLY ONE link — paste
  // the single university-eligibility link we found, never the whole list.
  await setChips(f.eligibility, firstLink(rec.university_eligibility_url), "uni_eligibility");
  await setChips(f.scholarship, rec.university_scholarship_url, "uni_scholarship");
  await setChips(f.fee, rec.university_fee_url, "uni_fee");
  await setField(f.brochure, rec.brochure_link, "brochure");
  await setField(f.notes, rec.notes, "notes");

  const newValue = [...filledNew, ...(warnings.length ? [`⚠ ${warnings.join("; ")}`] : [])].join(" | ");

  // NEVER save a half-pasted record: every link from the input file must sit in
  // its proper field, or the row goes to manual review (dry run reports it too).
  if (misplaced.length) {
    const shot = await reporter.screenshot(page, `uni-misplaced-${rec.university_name}`);
    return { action: "manual-review", status: "needs-review", reason: `NOT saved — links could not be placed in their proper fields: ${misplaced.join("; ")}`, oldValue: "", newValue, screenshot: shot };
  }

  if (config.dryRun) {
    const shot = await reporter.screenshot(page, `DRYRUN-uni-${action}-${rec.university_name}`);
    return { action: "dry-run", status: "planned", reason: `Planned ${action} (no save in dry run)${warnings.length ? ` | warnings: ${warnings.join("; ")}` : ""}`, oldValue: "", newValue, screenshot: shot };
  }

  // Commit: save AND confirm it persisted (a click alone is NOT proof — the form
  // stays on /form with a validation error if something's wrong).
  const result = await saveAndConfirm(page, f.save);
  const shot = await reporter.screenshot(page, `uni-${action}-${result}-${rec.university_name}`);
  if (result === "no-button") {
    return { action: "failed", status: "failed", reason: "Save button not found", oldValue: "", newValue, screenshot: shot };
  }
  if (result === "validation-error") {
    return { action: "manual-review", status: "needs-review", reason: `Save blocked by form validation error — check required fields`, oldValue: "", newValue, screenshot: shot };
  }
  if (result === "not-confirmed") {
    return { action: "manual-review", status: "needs-review", reason: `Clicked ${action} but save NOT confirmed (still on form — likely a required field/validation)`, oldValue: "", newValue, screenshot: shot };
  }
  return { action, status: "success", reason: `${action} saved & confirmed${warnings.length ? ` | warnings: ${warnings.join("; ")}` : ""}`, oldValue: "", newValue, screenshot: shot };
}
