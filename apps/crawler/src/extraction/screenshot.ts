import type { Page } from "playwright";
import { storagePaths, type StorageProvider } from "@clg/shared";

/** Capture a proof screenshot and persist it via the storage provider.
 *  Captures the desktop VIEWPORT (above-the-fold, where the page title + the start
 *  of the requirements live) as a JPEG — readable, recognizable, and ~5–10× smaller
 *  than a full-page PNG (keeps the screenshots folder from ballooning). Never throws
 *  — proof capture is best-effort and must not abort extraction. */
export async function captureScreenshot(
  page: Page,
  universityId: string,
  urlHash: string,
  storage: StorageProvider,
): Promise<string | null> {
  try {
    const buffer = await page.screenshot({ fullPage: false, type: "jpeg", quality: 72 });
    return await storage.saveBuffer(storagePaths.screenshot(universityId, urlHash), buffer);
  } catch {
    return null;
  }
}
