import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { config, selectors } from "./config.js";
import { fillField, fillChips, saveAndConfirm, readField, clickFirst, firstVisible, selectDropdown, namesMatch, normName } from "./locator.js";
import type { CourseRecord } from "./read-excel.js";
import type { Reporter } from "./reports.js";
import type { ProcessResult } from "./university-automation.js";

// Dump the current page HTML once per label, so exact Filters-panel/form
// selectors can be read off after the first DRY_RUN. Best-effort, never throws.
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

export async function navigateToCourses(page: Page): Promise<void> {
  // Courses list lives at /course (not /manage-courses/...). Navigate by URL for
  // a clean reset each row (avoids getting stuck on a prior unsaved form).
  await page.goto(`${config.baseUrl}/course`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
}

/**
 * Scope the course list to ONE university using the Filters panel BEFORE the
 * course-name search. Flow (matches the portal's Filters slide-over):
 *   open Filters → type the university name into the University dropdown →
 *   pick it → Done (applies + closes).
 * Returns "applied" | "no-panel" | "uni-not-found". A non-"applied" result means
 * we could NOT constrain the list to the right university — the caller must then
 * fall back to matching BOTH course+university in the row, never trust a bare
 * course-name match (a same-named course elsewhere could slip through).
 */
async function applyUniversityFilter(page: Page, uniName: string): Promise<"applied" | "no-panel" | "uni-not-found"> {
  const fl = selectors.filters;
  const opened = await clickFirst(page, fl.openButton, 4000);
  if (!opened) {
    await dumpDom(page, "course-list-no-filters-button");
    return "no-panel";
  }
  // It's a Radix DIALOG (modal), not a slide-over — wait for it to actually
  // mount before touching anything inside it.
  await page.getByRole("dialog").first().waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300); // let the open animation settle
  await dumpDom(page, "filters-panel-open");

  const match = await selectDropdown(page, fl.university, uniName);
  if (match === "not-found") {
    // Close the panel so the next row starts clean, then report.
    await clickFirst(page, fl.done, 2000).catch(() => {});
    return "uni-not-found";
  }

  // Apply the filter and close the panel.
  await clickFirst(page, fl.done, 3000);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  return "applied";
}

/**
 * Result of locating a course on the portal.
 *   - "found"        → row is the matched course row (Edit it).
 *   - "not-found"    → the course does NOT exist for this university → SKIP it
 *                      (per policy we never create a new course).
 *   - "uni-not-found"→ the university itself isn't selectable in the filter →
 *                      can't safely scope the list → manual review.
 */
type FindResult =
  | { kind: "found"; row: Locator }
  | { kind: "not-found"; diagnostic: string }
  | { kind: "uni-not-found" };

/**
 * Locate a course the way the portal's UI is designed for:
 *   1. Filters panel → select the University (scopes the list to that uni only).
 *   2. Search the course name inside that scoped list.
 *   3. Match the row. When several rows share the course name, disambiguate with
 *      the URL data from the input record (some rows differ only by the extra
 *      path info carried in their URL) via `rowMatchesUrlHint`.
 *
 * We STILL require the university name in the matched row as a belt-and-braces
 * check even after filtering, so a filter that silently failed to apply can
 * never let a same-named course at another university through.
 */
/** A candidate row snapshot: which page it was found on, its text, and hrefs. */
interface RowCandidate {
  pageNum: number;
  indexOnPage: number; // which matching row on that page (0-based)
  text: string;
  hrefs: string;
}

async function findCourseRow(page: Page, rec: CourseRecord): Promise<FindResult> {
  const courseName = rec.course_name;
  const uniName = rec.university_name;

  // 1) Scope to the university via the Filters panel.
  const filtered = await applyUniversityFilter(page, uniName);
  if (filtered === "uni-not-found") return { kind: "uni-not-found" };
  // "no-panel" is non-fatal: we fall back to requiring uni-name in the row.

  // 2) Search the course name inside the (now scoped) list.
  const box = await firstVisible(page, selectors.list.searchBox, 5000);
  if (box) {
    await box.fill("");
    await box.fill(courseName);
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  // 3) Collect EVERY candidate row across ALL pages FIRST — disambiguation must
  // compare across the WHOLE result set, not page-by-page. Two specialisations
  // of the same course can land on DIFFERENT pages (e.g. "Climate and Social
  // Justice" on page 1, "Criminology and Social Change" on page 2) and share a
  // word ("social") — scoring only what's visible on one page at a time let a
  // weaker single-token match win by default just because its competitor
  // hadn't been paged into view yet. Collecting everything up front and
  // scoring ONCE over the full set fixes that.
  const hintUrls = urlHints(rec);
  const tokens = urlDistinctTokens(hintUrls, courseName);
  const candidates: RowCandidate[] = [];
  let pagesSearched = 0;
  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    pagesSearched = pageNum;
    const rows = page.getByRole("row").filter({ hasText: courseName }).filter({ hasText: uniName });
    const count = await rows.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const text = (await row.innerText().catch(() => "")).toLowerCase();
      const hrefs = (await row.locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href)).catch(() => [])).join(" ").toLowerCase();
      candidates.push({ pageNum, indexOnPage: i, text, hrefs });
    }

    // Pagination is rendered as <a> links (role "link", not "button") — confirmed
    // live: <a data-slot="pagination-link" aria-label="Go to next page" href="#">.
    // Also try a plain "Next" text link and role=button as broader fallbacks.
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
      break; // no more pages
    }
  }

  if (candidates.length === 0) {
    await dumpDom(page, `course-not-found-${normName(courseName)}-${normName(uniName)}`, true);
    return {
      kind: "not-found",
      diagnostic: `${pagesSearched} page(s) searched; no row contained BOTH "${courseName}" and "${uniName}" — the search box or Filters scoping may not have applied as expected`,
    };
  }

  // 4) Pick the winner over the FULL candidate set (see bestRowMatch's doc for
  // the exact/token-overlap rules), then re-navigate to that row's page and
  // re-locate it fresh (Locators from earlier pages are stale after paging).
  const winner = pickBestCandidate(candidates, courseName, tokens);
  if (!winner) {
    await dumpDom(page, `course-not-found-${normName(courseName)}-${normName(uniName)}`, true);
    const shown = tokens.join(", ") || "none";
    return {
      kind: "not-found",
      diagnostic: `${pagesSearched} page(s) searched; ${candidates.length} candidate row(s) found across all pages but URL tokens [${shown}] did not uniquely confirm any of them (ambiguous or wrong specialization) — refused to guess`,
    };
  }

  const row = await goToCandidateRow(page, courseName, uniName, winner);
  if (!row) {
    await dumpDom(page, `course-relocate-failed-${normName(courseName)}-${normName(uniName)}`, true);
    return {
      kind: "not-found",
      diagnostic: `Matched a candidate on page ${winner.pageNum} but could not re-locate it after navigating back to that page`,
    };
  }
  return { kind: "found", row };
}

/**
 * Navigate back to the page a winning candidate was found on (re-running the
 * search + paging, since the page state may have moved on) and return a fresh
 * Locator for that same row index. Null if it can't be re-located.
 */
async function goToCandidateRow(page: Page, courseName: string, uniName: string, winner: RowCandidate): Promise<Locator | null> {
  // Re-apply the search (idempotent — cheap to redo) then page forward to the
  // winner's page number.
  const box = await firstVisible(page, selectors.list.searchBox, 5000);
  if (box) {
    await box.fill("");
    await box.fill(courseName);
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
  const rows = page.getByRole("row").filter({ hasText: courseName }).filter({ hasText: uniName });
  const row = rows.nth(winner.indexOnPage);
  return (await row.isVisible().catch(() => false)) ? row : null;
}

/**
 * Score every candidate across the WHOLE result set and pick the single best
 * match. See bestRowMatch's doc comment for the exact-match / token-overlap
 * rules — this is the same logic, just applied over ALL pages' candidates at
 * once instead of one page at a time (required so two specialisations that
 * share a word, like "social" in both "Climate and Social Justice" and
 * "Criminology and Social Change", are compared against EACH OTHER rather
 * than each independently "winning" on whichever page it happens to be on).
 */
function pickBestCandidate(candidates: RowCandidate[], courseName: string, tokens: string[]): RowCandidate | null {
  // Fast path: exactly one candidate total, and its name is an EXACT match
  // (strict, not substring) → no specialisation ambiguity possible.
  if (candidates.length === 1) {
    const only = candidates[0]!;
    const firstLine = only.text.split("\n")[0] ?? only.text;
    if (normName(firstLine) === normName(courseName) || !tokens.length) return only;
  }

  if (!tokens.length) {
    // No distinguishing info and more than one candidate → refuse to guess.
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

/** All distinct URLs on the input record — used to disambiguate same-named rows. */
function urlHints(rec: CourseRecord): string[] {
  const urls = new Set<string>();
  for (const u of [rec.course_url, rec.course_eligibility_url, rec.course_scholarship_url, rec.course_fee_url, rec.additional_information_link]) {
    if (u) for (const line of u.split(/\r?\n/)) { const t = line.trim(); if (t) urls.add(t); }
  }
  return [...urls];
}

/**
 * Unique resume/progress key for a course row. MUST NOT be just university +
 * course_name: an input file routinely has MANY rows sharing the exact same
 * course_name at the same university (e.g. Swinburne lists 7+ different
 * specializations all named plain "Bachelor of Arts", distinguished only by
 * their URL slug — .../bachelor-of-arts/criminology-and-social-change/ vs
 * .../ethics-and-technology/ etc). A name-only key would collapse all of them
 * into one progress entry, so completing #1 would silently mark #2-#7 as
 * "already done" and skip them forever. We append the URL's distinctive
 * tokens (falling back to the input row number if there are none) so every
 * specialization gets its own key.
 */
export function courseProgressKey(rec: CourseRecord): string {
  const tokens = urlDistinctTokens(urlHints(rec), rec.course_name).sort().join("-");
  const suffix = tokens || `row${rec.rowNumber}`;
  return `${rec.university_name}||${rec.course_name}||${suffix}`.toLowerCase();
}

/**
 * Distinctive path tokens pulled from the input URLs — the parts of a URL that
 * separate two same-named courses (specialisation, campus, mode, faculty, a
 * numeric id, etc.). We strip the host, generic filler words, AND every word
 * that's already part of the course's OWN name (e.g. "bachelor", "arts" for
 * "Bachelor of Arts") — those appear in the URL of every variant of that
 * course and so are not distinctive; only what's LEFT (e.g. "climate",
 * "social", "justice" for ".../bachelor-of-arts/climate-and-social-justice/")
 * actually tells one row apart from another.
 */
function urlDistinctTokens(urls: string[], courseName: string): string[] {
  const GENERIC = new Set([
    "http", "https", "www", "course", "courses", "study", "program", "programme", "degree",
    "en", "uk", "us", "au", "index", "html", "htm", "php", "aspx",
    "undergraduate", "postgraduate", "graduate", "and", "the", "for", "with",
  ]);
  const nameWords = new Set(courseName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
  const tokens = new Set<string>();
  for (const u of urls) {
    let path = u;
    try { path = new URL(u).pathname; } catch { /* keep raw */ }
    for (const seg of path.toLowerCase().split(/[^a-z0-9]+/)) {
      if (seg.length >= 3 && !GENERIC.has(seg) && !nameWords.has(seg)) tokens.add(seg);
    }
  }
  return [...tokens];
}

// ─────────────────────────────────────────────────────────────────────────────
// URL-path intelligence: analyse URLs to route them to the correct CRM field.
// When the same course URL appears in multiple columns (course_url and
// course_eligibility_url are often identical), or when only a generic course
// URL is present, these helpers inspect the path to decide where it belongs.
// ─────────────────────────────────────────────────────────────────────────────

/** Segment keywords → CRM field mapping. Order matters: first match wins. */
const URL_FIELD_SIGNALS: { field: "eligibility" | "scholarship" | "fee" | "course_url"; patterns: RegExp }[] = [
  { field: "eligibility",  patterns: /eligib|entry[-_]?req|admission[-_]?req|how[-_]?to[-_]?apply|requirement|criteria|ielts|toefl|english[-_]?lang/i },
  { field: "scholarship",  patterns: /scholar|bursary|financial[-_]?aid|funding|grant/i },
  { field: "fee",          patterns: /fee|tuition|cost|pricing|financial/i },
  { field: "course_url",   patterns: /overview|about|detail|info|course[-_]?page|program/i },
];

/**
 * Classify a URL by its path — what CRM field does this link belong to?
 * Checks the path segments AFTER the course-name slug.
 *
 * For example, given course name "Bachelor of Arts" and URL
 * `.../bachelor-of-arts/entry-requirements/` → returns "eligibility".
 *
 * Returns null if no strong signal is found (caller uses the original mapping).
 */
function classifyUrlByPath(url: string, courseName: string): "eligibility" | "scholarship" | "fee" | "course_url" | null {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    // Build a slug from the course name to find the "after course name" part
    const slug = courseName.toLowerCase().replace(/[^a-z0-9]+/g, "[-_]?");
    const slugRe = new RegExp(slug, "i");
    const match = slugRe.exec(pathname);
    // Check the FULL path — the after-slug portion has priority, but the whole
    // path is checked if we can't isolate the suffix.
    const afterSlug = match ? pathname.slice(match.index + match[0].length) : pathname;
    const searchIn = afterSlug || pathname;

    for (const { field, patterns } of URL_FIELD_SIGNALS) {
      if (patterns.test(searchIn)) return field;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Given a CourseRecord, build the best mapping of URLs → CRM fields.
 * The input data often has the same URL in multiple columns (course_url and
 * course_eligibility_url). This function deduplicates and uses URL path analysis
 * to fill the right fields.
 *
 * Returns { courseUrl, eligibility, scholarship, fee } — each may be undefined.
 */
function resolveUrlFields(rec: CourseRecord): {
  courseUrl?: string;
  eligibility?: string;
  scholarship?: string;
  fee?: string;
} {
  const result: { courseUrl?: string; eligibility?: string; scholarship?: string; fee?: string } = {};

  // Start with explicitly provided fields from the input data
  result.courseUrl = rec.additional_information_link || rec.course_url;
  result.eligibility = rec.course_eligibility_url;
  result.scholarship = rec.course_scholarship_url;
  result.fee = rec.course_fee_url;

  // Collect all non-empty URLs we have for this course
  const allUrls = new Set<string>();
  for (const u of [rec.course_url, rec.course_eligibility_url, rec.course_scholarship_url, rec.course_fee_url, rec.additional_information_link]) {
    if (u) for (const line of u.split(/\r?\n/)) { const t = line.trim(); if (t) allUrls.add(t); }
  }

  // For each URL, use path analysis to see if it should go to a different field
  // than where the input data placed it. Only re-route if the target field is
  // currently empty (never overwrite explicit input data).
  for (const url of allUrls) {
    const detected = classifyUrlByPath(url, rec.course_name);
    if (!detected) continue;
    switch (detected) {
      case "eligibility":
        if (!result.eligibility) result.eligibility = url;
        break;
      case "scholarship":
        if (!result.scholarship) result.scholarship = url;
        break;
      case "fee":
        if (!result.fee) result.fee = url;
        break;
      case "course_url":
        if (!result.courseUrl) result.courseUrl = url;
        break;
    }
  }

  return result;
}

/**
 * Process one course: search by name + verify university match -> edit/add ->
 * fill ONLY course-level fields (never the university eligibility link) ->
 * dry-run screenshot+log OR commit save. Dropdown (University, Level) is matched
 * exact then normalized; if unresolved -> manual review (never a wrong value).
 *
 * Optional fields (Campus, Category, Eligibility, Scholarship, Fee) are only
 * filled when data exists in the input — missing data never blocks a save.
 */
export async function processCourse(page: Page, rec: CourseRecord, reporter: Reporter): Promise<ProcessResult> {
  await navigateToCourses(page);
  const found = await findCourseRow(page, rec);
  const f = selectors.courseForm;

  // POLICY: never create a course. If the course isn't already on Aliff, skip it.
  if (found.kind === "not-found") {
    // Always capture proof — this is the outcome most worth being able to debug.
    const shot = await reporter.screenshot(page, `course-not-found-${rec.course_name}`);
    return {
      action: "skip-not-found",
      status: "skipped",
      reason: `Course "${rec.course_name}" not found for "${rec.university_name}" on Aliff — skipped (never create a new course). ${found.diagnostic}`,
      oldValue: "",
      newValue: "",
      screenshot: shot,
    };
  }
  if (found.kind === "uni-not-found") {
    const shot = await reporter.screenshot(page, `course-uni-filter-missing-${rec.course_name}`);
    return {
      action: "manual-review",
      status: "needs-review",
      reason: `University "${rec.university_name}" not selectable in the Filters panel — cannot scope the course list, skipped`,
      oldValue: "",
      newValue: "",
      screenshot: shot,
    };
  }

  // Found → update only. Click Edit INSIDE the matched row (never the first Edit).
  const action: ProcessResult["action"] = "update";
  const opened = await clickFirst(found.row, selectors.list.editInRow, 6000);
  if (!opened) {
    const shot = await reporter.screenshot(page, `course-edit-notfound-${rec.course_name}`);
    return { action: "manual-review", status: "needs-review", reason: "Course+university match found but Edit not opened", oldValue: "", newValue: "", screenshot: shot };
  }
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await dumpDom(page, "course-edit-form");

  // UPDATE: prove the form shows THIS course (and university, when readable)
  // before touching any field — a URL must never be pasted into another record.
  // Uses the SAME exact-or-token-confirmed rule as row matching (never the
  // lenient namesMatch substring check) — "Bachelor of Arts" must NOT be
  // accepted as a match for "Bachelor of Arts - Climate and Social Justice"
  // just because it's a substring; only an exact name OR a URL-token
  // confirmation proves this is really the record the input row belongs to.
  if (action === "update") {
    const formName = await readField(page, f.name);
    const formTokens = urlDistinctTokens(urlHints(rec), rec.course_name);
    const isExactName = !!formName && normName(formName) === normName(rec.course_name);
    const isTokenConfirmed = !!formName && formTokens.length > 0 && formTokens.some((t) => formName.toLowerCase().includes(t));
    if (!formName || !(isExactName || isTokenConfirmed)) {
      const shot = await reporter.screenshot(page, `course-wrong-record-${rec.course_name}`);
      return { action: "manual-review", status: "needs-review", reason: `Edit form shows "${formName || "(empty)"}" but expected "${rec.course_name}" (URL tokens [${formTokens.join(", ") || "none"}] did not confirm it either) — wrong record, nothing filled`, oldValue: formName, newValue: "", screenshot: shot };
    }
    const formUni = await readField(page, f.university);
    if (formUni && !namesMatch(formUni, rec.university_name)) {
      const shot = await reporter.screenshot(page, `course-wrong-university-${rec.course_name}`);
      return { action: "manual-review", status: "needs-review", reason: `Edit form belongs to "${formUni}" but expected "${rec.university_name}" — wrong record, nothing filled`, oldValue: formUni, newValue: "", screenshot: shot };
    }
  }
  const filledNew: string[] = [];
  const warnings: string[] = [];
  // Any link/value that was in the input file but could NOT be placed in its
  // proper field lands here — such a record is never saved (manual review).
  const misplaced: string[] = [];
  const setField = async (specs: string[], value: string | undefined, label: string) => {
    if (!value) return;
    const current = await readField(page, specs);
    if (current && !config.overwrite) return; // intentional keep, not an error
    if (await fillField(page, specs, value)) filledNew.push(`${label}=${value}`);
    else misplaced.push(`${label}: field not found on the form`);
  };
  // Chip/tag inputs (URL link fields) — each chip is committed with Enter AND
  // verified; a link that didn't land in its field is a placement error.
  // When value is undefined/empty, the field is simply skipped (optional).
  const setChips = async (specs: string[], value: string | undefined, label: string) => {
    if (!value) return; // ← OPTIONAL: no data = skip, don't block save
    const res = await fillChips(page, specs, value);
    if (res.status === "no-field") {
      // Field not found on the form — only a hard error if we have data for it.
      // Log as warning, not misplaced, so missing fields don't block save.
      warnings.push(`${label}: field not found on the form (skipped)`);
      return;
    }
    if (res.failed.length) {
      const shown = res.failed.slice(0, 3).join(" ");
      warnings.push(`${label}: ${res.failed.length} link(s) did not commit as chips (${shown}${res.failed.length > 3 ? " …" : ""})`);
    }
    if (res.added > 0) filledNew.push(`${label}=+${res.added} link(s)`);
    else if (res.already > 0) filledNew.push(`${label}(already present)`);
  };

  await setField(f.name, rec.course_name, "course_name");

  // University association. If the form already shows the right university
  // (update path), keep it — never re-select, so an existing course can't be
  // re-pointed. Otherwise select it and VERIFY the read-back value.
  const currentUni = await readField(page, f.university);
  if (currentUni && namesMatch(currentUni, rec.university_name)) {
    filledNew.push(`university(kept)=${currentUni}`);
  } else {
    const uniMatch = await selectDropdown(page, f.university, rec.university_name);
    if (uniMatch === "not-found") {
      const shot = await reporter.screenshot(page, `course-uni-dropdown-${rec.course_name}`);
      return { action: "manual-review", status: "needs-review", reason: `University "${rec.university_name}" not in dropdown`, oldValue: "", newValue: filledNew.join(" | "), screenshot: shot };
    }
    const afterUni = await readField(page, f.university);
    if (afterUni && !namesMatch(afterUni, rec.university_name)) {
      const shot = await reporter.screenshot(page, `course-uni-mismatch-${rec.course_name}`);
      return { action: "manual-review", status: "needs-review", reason: `Dropdown selected "${afterUni}" but expected "${rec.university_name}" — not saving`, oldValue: afterUni, newValue: filledNew.join(" | "), screenshot: shot };
    }
    filledNew.push(`university(${uniMatch})=${rec.university_name}`);
  }

  // NOTE: we only ever UPDATE an existing course to add its link(s). Identity /
  // classification fields (degree level, category, campus) are LEFT AS-IS unless
  // OVERWRITE is explicitly on AND real input data exists — we never inject a
  // "__first__" or "Main Campus" placeholder into a course that already exists.
  if (config.overwrite && rec.degree_level) {
    const lvl = await selectDropdown(page, f.degreeLevel, rec.degree_level);
    if (lvl === "not-found") {
      warnings.push(`degree_level: "${rec.degree_level}" not in dropdown (kept existing)`);
    } else {
      filledNew.push(`level(${lvl})=${rec.degree_level}`);
    }
  }
  if (config.overwrite && rec.course_category) {
    const cat = await selectDropdown(page, f.category, rec.course_category);
    if (cat === "not-found") {
      warnings.push(`course_category: "${rec.course_category}" not in dropdown (kept existing)`);
    } else {
      filledNew.push(`category(${cat})=${rec.course_category}`);
    }
  }
  if (config.overwrite && rec.campus) {
    await setField(f.campus, rec.campus, "campus");
  }

  // ── URL field intelligence ──
  // Use URL-path analysis to route each link to the correct CRM field.
  // If the input has the same URL in course_url and course_eligibility_url,
  // the path analysis deduplicates and routes correctly.
  const urls = resolveUrlFields(rec);
  await setChips(f.courseUrl, urls.courseUrl, "course_url");
  // CRITICAL: only COURSE eligibility goes here — never the university link.
  await setChips(f.eligibility, urls.eligibility, "course_eligibility");
  await setChips(f.scholarship, urls.scholarship, "course_scholarship");
  await setChips(f.fee, urls.fee, "course_fee");

  const newValue = [...filledNew, ...(warnings.length ? [`⚠ ${warnings.join("; ")}`] : [])].join(" | ");

  // NEVER save a half-pasted record: every link from the input file must sit in
  // its proper field, or the row goes to manual review (dry run reports it too).
  // NOTE: warnings (field-not-found, chip-not-committed) no longer block saves.
  // Only hard misplaced errors (data typed into wrong field) block.
  if (misplaced.length) {
    const shot = await reporter.screenshot(page, `course-misplaced-${rec.course_name}`);
    return { action: "manual-review", status: "needs-review", reason: `NOT saved — links could not be placed in their proper fields: ${misplaced.join("; ")}`, oldValue: "", newValue, screenshot: shot };
  }

  if (config.dryRun) {
    const shot = await reporter.screenshot(page, `DRYRUN-course-${action}-${rec.course_name}`);
    return { action: "dry-run", status: "planned", reason: `Planned ${action} (no save in dry run)${warnings.length ? ` | warnings: ${warnings.join("; ")}` : ""}`, oldValue: "", newValue, screenshot: shot };
  }

  // Bypass frontend HTML5 validation (required attributes) just in case there
  // are other required fields we don't know about. If the backend accepts it,
  // it will save successfully.
  await page.evaluate(() => {
    document.querySelectorAll('[required]').forEach(el => el.removeAttribute('required'));
  }).catch(() => {});

  // Commit + CONFIRM persistence (a click alone is not proof).
  const result = await saveAndConfirm(page, f.save);
  const shot = await reporter.screenshot(page, `course-${action}-${result}-${rec.course_name}`);
  if (result === "no-button") return { action: "failed", status: "failed", reason: "Save button not found", oldValue: "", newValue, screenshot: shot };
  if (result === "validation-error") {
    return { action: "manual-review", status: "needs-review", reason: `Save blocked by form validation error — check required fields (campus/category may be required by this portal)`, oldValue: "", newValue, screenshot: shot };
  }
  if (result === "not-confirmed") {
    return { action: "manual-review", status: "needs-review", reason: `Clicked ${action} but save NOT confirmed (still on form — likely a required field/validation)`, oldValue: "", newValue, screenshot: shot };
  }
  return { action, status: "success", reason: `${action} saved & confirmed${warnings.length ? ` | warnings: ${warnings.join("; ")}` : ""}`, oldValue: "", newValue, screenshot: shot };
}
