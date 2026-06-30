import type { Page } from "playwright";
import { config, selectors } from "./config.js";
import { fillField, clickFirst, isPresent } from "./locator.js";

/**
 * Log in to Aliff Super Admin using credentials from the environment.
 * Credentials are NEVER hardcoded — they come from ALIFF_EMAIL / ALIFF_PASSWORD.
 */
export async function login(page: Page): Promise<void> {
  // The portal can be slow — retry the initial navigation a few times.
  let navOk = false;
  for (let attempt = 0; attempt < 3 && !navOk; attempt++) {
    try {
      await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      navOk = true;
    } catch {
      if (attempt === 2) throw new Error("Could not reach the Aliff login page after 3 tries (network/portal slow).");
      await page.waitForTimeout(2000);
    }
  }

  const okEmail = await fillField(page, selectors.login.email, config.email);
  const okPass = await fillField(page, selectors.login.password, config.password);
  if (!okEmail || !okPass) {
    throw new Error(
      "Could not find the email/password fields on the login page. Update selectors.login in config.ts (check ./screenshots).",
    );
  }
  await clickFirst(page, selectors.login.submit);

  // Wait for navigation / a logged-in marker.
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const loggedIn = await isPresent(page, selectors.login.loggedIn, 10000);
  if (!loggedIn) {
    // Not fatal in dry run, but warn loudly.
    if (page.url().includes("/login")) {
      throw new Error("Login appears to have failed (still on /login). Check credentials or selectors.login.");
    }
  }
}
