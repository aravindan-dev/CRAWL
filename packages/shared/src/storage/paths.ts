/**
 * Canonical storage path builders (Section 21). All keyed by university id +
 * the SHA-256 hash of the final URL so artifacts for the same page collide
 * deterministically and are idempotent to rewrite.
 */
export const storagePaths = {
  screenshot: (universityId: string, urlHash: string): string =>
    `storage/screenshots/${universityId}/${urlHash}.jpg`,
  html: (universityId: string, urlHash: string): string =>
    `storage/html/${universityId}/${urlHash}.html`,
  text: (universityId: string, urlHash: string): string =>
    `storage/text/${universityId}/${urlHash}.txt`,
  exportCsv: (exportId: string): string => `storage/exports/${exportId}.csv`,
  exportXlsx: (exportId: string): string => `storage/exports/${exportId}.xlsx`,
};
