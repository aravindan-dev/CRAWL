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
    case "css":
    default:
      return scope.locator(kind === "css" ? val : spec);
  }
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
  await loc.fill("");
  await loc.fill(value);
  return true;
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
 * Fill a CHIP/tag input: type each value and press Enter so it commits as a chip
 * (these portal fields discard uncommitted draft text on save). Multiple URLs may
 * be newline-separated. Returns true if at least one chip was committed.
 */
export async function fillChips(scope: Page | Locator, specs: string[], value: string): Promise<boolean> {
  const loc = await firstVisible(scope, specs);
  if (!loc) return false;
  const items = value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return false;
  let added = 0;
  for (const item of items) {
    // Duplicate guard: skip if this URL is already a committed chip on the page.
    const exists = await scope.getByText(item, { exact: false }).first().isVisible().catch(() => false);
    if (exists) continue;
    await loc.fill(item);
    await loc.press("Enter");
    added += 1;
  }
  return added > 0;
}

/**
 * Click the save/submit button AND confirm the save actually persisted: success =
 * the app navigates away from the /form page (back to the list) or shows a success
 * toast. Returns "no-button" | "saved" | "not-confirmed" so callers never report a
 * false success (the click alone is not proof).
 */
export async function saveAndConfirm(page: Page, specs: string[]): Promise<"no-button" | "saved" | "not-confirmed"> {
  const loc = await firstVisible(page, specs, 8000);
  if (!loc) return "no-button";
  const onForm = /\/form(\?|$)/;
  await loc.click();
  // Poll for proof of persistence: navigated away from /form OR a success toast.
  for (let i = 0; i < 24; i++) {
    if (!onForm.test(page.url())) return "saved";
    if (await page.getByText(/successfully|success/i).first().isVisible().catch(() => false)) return "saved";
    await page.waitForTimeout(500);
  }
  return "not-confirmed";
}

export async function isPresent(scope: Page | Locator, specs: string[], timeoutMs = 3000): Promise<boolean> {
  return (await firstVisible(scope, specs, timeoutMs)) !== null;
}

/**
 * Select an option in a <select> or combobox by exact then normalized match.
 * Returns "exact" | "normalized" | "not-found".
 */
export async function selectDropdown(
  scope: Page | Locator,
  specs: string[],
  value: string,
): Promise<"exact" | "normalized" | "not-found"> {
  const loc = await firstVisible(scope, specs);
  if (!loc) return "not-found";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(value);

  // Native <select>?
  const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  if (tag === "select") {
    const options = await loc.locator("option").allTextContents();
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

  // Custom combobox: type then pick a matching option.
  await loc.click();
  await loc.fill?.(value).catch(() => {});
  const optExact = scope.getByRole("option", { name: value, exact: true }).first();
  if (await optExact.isVisible().catch(() => false)) {
    await optExact.click();
    return "exact";
  }
  const optAny = scope.getByRole("option").filter({ hasText: value }).first();
  if (await optAny.isVisible().catch(() => false)) {
    await optAny.click();
    return "normalized";
  }
  return "not-found";
}
