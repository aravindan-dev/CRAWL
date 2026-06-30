import { resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { repoRoot } from "@clg/shared";
import { prisma } from "@clg/database";

/**
 * Disk-space management. Crawls accumulate a lot of data — screenshots (one per
 * visited page), cached HTML/text, and export files. After exporting, the user
 * can reclaim that space here without touching the universities list or the
 * validated exports they care about.
 */
const DIRS = {
  screenshots: "storage/screenshots",
  html: "storage/html",
  text: "storage/text",
  exports: "storage/exports",
  backups: "storage/backups",
} as const;
export type StorageTarget = keyof typeof DIRS;

function dirSize(abs: string): number {
  if (!existsSync(abs)) return 0;
  let total = 0;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const p = resolve(abs, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(p);
      else total += statSync(p).size;
    } catch {
      /* file vanished mid-scan */
    }
  }
  return total;
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** Per-area disk usage + DB row counts, so the dashboard can show what's safe to clear. */
export async function getStorageUsage() {
  const areas = (Object.keys(DIRS) as StorageTarget[]).map((key) => {
    const bytes = dirSize(resolve(repoRoot(), DIRS[key]));
    return { key, bytes, human: human(bytes) };
  });
  const totalBytes = areas.reduce((s, a) => s + a.bytes, 0);
  const [links, snapshots, criteria] = await Promise.all([
    prisma.discoveredLink.count(),
    prisma.pageSnapshot.count(),
    prisma.courseCriteria.count(),
  ]);
  return {
    areas,
    totalBytes,
    totalHuman: human(totalBytes),
    db: { links, snapshots, criteria },
  };
}

/** Empty a storage directory's contents (keeps the top folder itself). */
function emptyDir(abs: string): number {
  const freed = dirSize(abs);
  if (existsSync(abs)) {
    for (const entry of readdirSync(abs)) {
      try { rmSync(resolve(abs, entry), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  mkdirSync(abs, { recursive: true });
  return freed;
}

/**
 * Delete the files for the chosen areas and null the now-dangling DB paths so the
 * UI never tries to load a missing screenshot/page. Universities, discovered
 * links, criteria and the validated exports stay intact (unless `exports` chosen).
 */
export async function cleanupArtifacts(targets: StorageTarget[]) {
  const valid = targets.filter((t): t is StorageTarget => t in DIRS);
  let freed = 0;
  for (const t of valid) freed += emptyDir(resolve(repoRoot(), DIRS[t]));

  // Keep the database consistent with what's now on disk.
  if (valid.includes("screenshots")) {
    await prisma.discoveredLink.updateMany({ data: { screenshot_path: null } });
    await prisma.pageSnapshot.updateMany({ data: { screenshot_path: null } });
  }
  if (valid.includes("html")) {
    await prisma.discoveredLink.updateMany({ data: { html_path: null } });
    await prisma.pageSnapshot.updateMany({ data: { raw_html_path: null } });
  }
  if (valid.includes("text")) {
    await prisma.discoveredLink.updateMany({ data: { text_path: null } });
    await prisma.pageSnapshot.updateMany({ data: { cleaned_text_path: null } });
  }
  return { cleared: valid, freedBytes: freed, freedHuman: human(freed) };
}

/**
 * Clear crawl data (discovered links, page snapshots, parsed criteria, logs and
 * jobs) AND their on-disk artifacts — but KEEP the universities list and any
 * validated exports. For when the export is done and you want a clean slate to
 * re-crawl without re-adding universities. FK-safe delete order.
 */
export async function clearCrawlData() {
  const criteria = (await prisma.courseCriteria.deleteMany({})).count;
  const snapshots = (await prisma.pageSnapshot.deleteMany({})).count;
  const links = (await prisma.discoveredLink.deleteMany({})).count;
  const logs = (await prisma.crawlLog.deleteMany({})).count;
  const jobs = (await prisma.crawlJob.deleteMany({})).count;
  await prisma.university.updateMany({ data: { crawl_status: "IDLE" } });
  let freed = 0;
  for (const t of ["screenshots", "html", "text"] as StorageTarget[]) {
    freed += emptyDir(resolve(repoRoot(), DIRS[t]));
  }
  return { criteria, snapshots, links, logs, jobs, freedBytes: freed, freedHuman: human(freed) };
}
