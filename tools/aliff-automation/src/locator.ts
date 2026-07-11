import type { Locator, Page } from "playwright";

/**
 * Resolve a single selector spec (see config.ts syntax) to a Locator.
 */
function resolve(scope: Page | Locator, spec: string): Locator {
  const idx = spec.indexOf(":");
  const kind = spec.slice(0, idx);
  const val = spec.slice(idx + 1);
  switch (kind) {
    case "label":
      return scope.getByLabel(val, { exact: false });
    case "placeholder":
      return scope.getByPlaceholder(val, { exact: false });
    case "text":
      return scope.getByText(val, { exact: false });
    case "role": {
      const [role, name] = val.split("|");
      return scope.getByRole(role as Parameters<Page["getByRole"]>[0], name ? { name, exact: false } : {});
    }
    case "xpath":
      return scope.locator(`xpath=${val}`);
    case "css":
    default:
      // Also handle raw XPath that starts with // (legacy selectors)
      if (!kind || spec.startsWith("//")) return scope.locator(spec.startsWith("//") ? `xpath=${spec}` : spec);
      return scope.locator(kind === "css" ? val : spec);
  }
}

/** Normalize a name for comparison: lowercase, alphanumerics only. */
export function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * True when two names refer to the same record: equal after normalization, or
 * one contains the other (list rows / form values often carry extra suffixes
 * like "(UniLink)" or campus tags that normalization alone doesn't erase).
 */
export function namesMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Find the list ROW whose own text contains ALL the given texts — the same row,
 * not merely somewhere on the page (a university name in a sidebar or another
 * row must NOT count as a match). Tries ARIA rows, then <tr>. Null if none.
 */
export async function findRowWithTexts(page: Page, texts: string[], timeoutMs = 4000): Promise<Locator | null> {
  for (const base of [page.getByRole("row"), page.locator("tr")]) {
    let rows = base;
    for (const t of texts) rows = rows.filter({ hasText: t });
    const row = rows.first();
    try {
      await row.waitFor({ state: "visible", timeout: timeoutMs });
      return row;
    } catch {
      /* try the next row shape */
    }
  }
  return null;
}

/** First spec that resolves to a visible element, or null. */
export async function firstVisible(scope: Page | Locator, specs: string[], timeoutMs = 4000): Promise<Locator | null> {
  for (const spec of specs) {
    const loc = resolve(scope, spec).first();
    try {
      await loc.waitFor({ state: "visible", timeout: timeoutMs });
      return loc;
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function fillField(scope: Page | Locator, specs: string[], value: string): Promise<boolean> {
  const loc = await firstVisible(scope, specs);
  if (!loc) return false;
  await scrollIntoView(loc);
  await loc.fill("");
  await loc.fill(value);
  return true;
}

/** Scroll an element into view — chip inputs below the fold need this. */
export async function scrollIntoView(loc: Locator): Promise<void> {
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
  } catch {
    /* best-effort */
  }
}

/** Read a field's current value (for OVERWRITE logic). "" if not found. */
export async function readField(scope: Page | Locator, specs: string[]): Promise<string> {
  const loc = await firstVisible(scope, specs, 2000);
  if (!loc) return "";
  try {
    return (await loc.inputValue()).trim();
  } catch {
    return "";
  }
}

export async function clickFirst(scope: Page | Locator, specs: string[], timeoutMs = 6000): Promise<boolean> {
  const loc = await firstVisible(scope, specs, timeoutMs);
  if (!loc) return false;
  await loc.click();
  return true;
}

/**
 * Result of filling a chip field. Callers must treat "no-field" and a non-empty
 * `failed` list as placement errors — a link that was in the input file but is
 * not committed as a chip in the RIGHT field must never pass silently.
 */
export type ChipResult =
  | { status: "no-field" }
  | { status: "ok"; added: number; already: number; failed: string[] };

/**
 * Fill a CHIP/tag input: type each value and press Enter so it commits as a chip
 * (these portal fields discard uncommitted draft text on save). Multiple URLs may
 * be newline-separated. Every chip is VERIFIED after Enter: it must appear in the
 * field's own wrapper (or the input must clear itself), else it counts as failed.
 */
export async function fillChips(scope: Page | Locator, specs: string[], value: string): Promise<ChipResult> {
  const loc = await firstVisible(scope, specs);
  if (!loc) return { status: "no-field" };
  const items = value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return { status: "ok", added: 0, already: 0, failed: [] };
  await scrollIntoView(loc);
  // Duplicate guard scoped to the FIELD's own wrapper — chips render beside their
  // input. A page-wide check would silently skip a URL that legitimately appears
  // in a DIFFERENT field (e.g. the same link as course_url and eligibility).
  const wrapper = loc.locator("xpath=ancestor::*[position()<=3]").first();
  let added = 0;
  let already = 0;
  const failed: string[] = [];
  for (const item of items) {
    const exists = await wrapper.getByText(item, { exact: false }).first().isVisible().catch(() => false);
    if (exists) {
      already += 1;
      continue;
    }
    await loc.fill(item);
    await loc.press("Enter");
    await loc.page().waitForTimeout(250);
    // Proof of commit: the chip renders in this field's wrapper, or the input
    // cleared itself (chip inputs empty on commit). Text still sitting in the
    // input means an uncommitted draft — the portal drops it on save.
    const chipShown = await wrapper.getByText(item, { exact: false }).first().isVisible().catch(() => false);
    const draft = await loc.inputValue().catch(() => "");
    if (chipShown || draft.trim() === "") {
      added += 1;
    } else {
      failed.push(item);
      await loc.fill("").catch(() => { }); // clear the dead draft
    }
  }
  return { status: "ok", added, already, failed };
}

/**
 * Click the save/submit button AND confirm the save actually persisted: success =
 * the app navigates away from the form page (back to the list) or shows a success
 * toast. Returns "no-button" | "saved" | "not-confirmed" | "validation-error" so
 * callers never report a false success (the click alone is not proof).
 */
export async function saveAndConfirm(page: Page, specs: string[]): Promise<"no-button" | "saved" | "not-confirmed" | "validation-error"> {
  const loc = await firstVisible(page, specs, 8000);
  if (!loc) return "no-button";
  await scrollIntoView(loc);
  // Broader regex: match any URL containing /form, /create, /edit, /add (the
  // portal may use any of these for the course/university creation page).
  const onFormPage = /\/(form|create|edit|add)(\?|\/|$)/i;
  const urlBefore = page.url();
  await loc.click();
  // Poll for proof of persistence: navigated away from the form page, OR a
  // success toast appeared, OR a validation error surfaced.
  for (let i = 0; i < 30; i++) {
    const currentUrl = page.url();
    // URL changed away from the form page → saved
    if (currentUrl !== urlBefore && !onFormPage.test(currentUrl)) return "saved";
    // Even if URL didn't change, if the form-page pattern is gone → saved
    if (!onFormPage.test(currentUrl)) return "saved";
    // Success toast
    if (await page.getByText(/successfully|success|created|updated/i).first().isVisible().catch(() => false)) return "saved";
    // Validation error — the portal shows an inline error or a toast error
    const errorLocators = ['.error', '.form-error', '[role="alert"]', '.toast-error', '.field-error', '.text-red', '.text-danger'];
    for (const sel of errorLocators) {
      const texts = await page.locator(sel).allTextContents().catch(() => []);
      const visibleTexts = texts.map(t => t.trim()).filter(Boolean);
      if (visibleTexts.length > 0) {
        console.log(`\n[VALIDATION ERROR DETECTED]: ${visibleTexts.join(" | ")}\n`);
        return "validation-error";
      }
    }
    await page.waitForTimeout(400);
  }
  return "not-confirmed";
}

export async function isPresent(scope: Page | Locator, specs: string[], timeoutMs = 3000): Promise<boolean> {
  return (await firstVisible(scope, specs, timeoutMs)) !== null;
}

/**
 * Select an option in a <select> or combobox by exact then normalized match.
 * Returns "exact" | "normalized" | "not-found" | "first-fallback".
 */
export async function selectDropdown(
  scope: Page | Locator,
  specs: string[],
  value: string,
): Promise<"exact" | "normalized" | "not-found" | "first-fallback"> {
  const loc = await firstVisible(scope, specs);
  if (!loc) return "not-found";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(value);
  const isFirstFallback = value === "__first__";

  // Native <select>?
  const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  if (tag === "select") {
    const options = await loc.locator("option").allTextContents();
    const validOptions = options.map(o => o.trim()).filter(o => o && !o.toLowerCase().startsWith("select"));
    if (isFirstFallback && validOptions.length > 0) {
      await loc.selectOption({ label: validOptions[0] });
      return "first-fallback";
    }
    const exact = options.find((o) => o.trim() === value.trim());
    if (exact) {
      await loc.selectOption({ label: exact });
      return "exact";
    }
    const normMatch = options.find((o) => norm(o) === target);
    if (normMatch) {
      await loc.selectOption({ label: normMatch });
      return "normalized";
    }
    return "not-found";
  }

  // Custom combobox
  await loc.click();
  if (!isFirstFallback) {
    await loc.fill?.(value).catch(() => { });
  }
  await loc.page().waitForTimeout(500); // let the option list filter/render
  const options = scope.getByRole("option");
  const texts = (await options.allTextContents().catch(() => [])).map((t) => t.trim());
  const validTexts = texts.filter(t => t && !t.toLowerCase().startsWith("select"));

  if (isFirstFallback && validTexts.length > 0) {
    const idx = texts.findIndex(t => t === validTexts[0]);
    if (idx >= 0) {
      await options.nth(idx).click();
      return "first-fallback";
    }
  }

  const exactIdx = texts.findIndex((t) => t === value.trim());
  if (exactIdx >= 0) {
    await options.nth(exactIdx).click();
    return "exact";
  }
  const normIdx = texts.findIndex((t) => norm(t) === target);
  if (normIdx >= 0) {
    await options.nth(normIdx).click();
    return "normalized";
  }
  const contains = texts
    .map((t, i) => ({ nt: norm(t), i }))
    .filter(({ nt }) => nt.length > 0 && (nt.includes(target) || target.includes(nt)));
  if (contains.length === 1) {
    await options.nth(contains[0]!.i).click();
    return "normalized";
  }
  return "not-found";
}
