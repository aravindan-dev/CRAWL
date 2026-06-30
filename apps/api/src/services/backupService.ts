import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { repoRoot } from "@clg/shared";
import { prisma, universityRepository } from "@clg/database";

/**
 * Lightweight, one-click backup/restore of the IRREPLACEABLE data: the curated
 * university list + manual coverage decisions + custom keywords. (Crawl links /
 * snapshots are regenerable by crawling, so they're intentionally not included —
 * keeps backups small and fast.) Backups are plain JSON in storage/backups/.
 */
const BACKUP_DIR = resolve(repoRoot(), "storage", "backups");
const OVERRIDES_PATH = resolve(repoRoot(), "storage", "coverage-overrides.json");
const KEYWORDS_PATH = resolve(repoRoot(), "storage", "keywords.json");

interface BackupFile {
  createdAt: string;
  tag: string;
  universities: { name: string; country: string; base_url: string; notes: string | null }[];
  overrides: unknown;
  keywords: unknown;
}

const readJson = (p: string): unknown => { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };

/** Snapshot universities + overrides + keywords to a timestamped JSON file. */
export async function backupData(tag = "manual"): Promise<{ file: string; universities: number }> {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const universities = await prisma.university.findMany({
    select: { name: true, country: true, base_url: true, notes: true },
    orderBy: { name: "asc" },
  });
  const data: BackupFile = {
    createdAt: new Date().toISOString(),
    tag,
    universities,
    overrides: readJson(OVERRIDES_PATH),
    keywords: readJson(KEYWORDS_PATH),
  };
  const file = `clg-backup-${tag}-${data.createdAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(join(BACKUP_DIR, file), JSON.stringify(data, null, 2), "utf8");
  return { file, universities: universities.length };
}

/** List available backups, newest first. */
export function listBackups(): { backups: { file: string; size: number; at: string; universities: number }[] } {
  if (!existsSync(BACKUP_DIR)) return { backups: [] };
  const backups = readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const st = statSync(join(BACKUP_DIR, f));
      let universities = 0;
      try { universities = (((readJson(join(BACKUP_DIR, f)) as BackupFile)?.universities) ?? []).length; } catch { /* ignore */ }
      return { file: f, size: st.size, at: st.mtime.toISOString(), universities };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  return { backups };
}

/** Restore universities (+ overrides + keywords) from a backup (latest by default). */
export async function restoreData(file?: string): Promise<{ file: string; restored: number; total: number }> {
  if (!existsSync(BACKUP_DIR)) throw new Error("No backups found yet — make a backup first.");
  const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json")).sort();
  const target = file && files.includes(file) ? file : files[files.length - 1];
  if (!target) throw new Error("No backup file to restore.");
  const data = readJson(join(BACKUP_DIR, target)) as BackupFile | null;
  if (!data || !Array.isArray(data.universities)) throw new Error("That backup file is empty or unreadable.");

  const restored = data.universities.length
    ? await universityRepository.createMany(
        data.universities.map((u) => ({ name: u.name, country: u.country, base_url: u.base_url ?? "", notes: u.notes ?? null })),
      )
    : 0;
  if (data.overrides) writeFileSync(OVERRIDES_PATH, JSON.stringify(data.overrides, null, 2), "utf8");
  if (data.keywords) writeFileSync(KEYWORDS_PATH, JSON.stringify(data.keywords, null, 2), "utf8");

  const total = await prisma.university.count();
  return { file: target, restored, total };
}
