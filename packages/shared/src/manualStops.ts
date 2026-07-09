/**
 * MANUAL-STOP registry — distinguishes a crawl the USER deliberately stopped from
 * one the engine auto-stopped (page budget, an incomplete run, a crash/restart).
 *
 * The rule the product wants: a crawl the engine auto-stops MAY be auto-resumed
 * (on engine boot / by the stall watchdog); a crawl the user manually stopped must
 * NOT be auto-resumed — it only runs again when the user explicitly Resumes or
 * starts it.
 *
 * Both `crawl_status` values would otherwise be identical (STOPPED), and adding a
 * column is out of scope (no schema change), so the manual-stop intent is recorded
 * here as a tiny storage-backed set of university ids — the same pattern the
 * engine already uses for fingerprints / recheck state. Best-effort: a read/write
 * failure never breaks a crawl (it just falls back to the old "resume everything"
 * behavior, which is safe).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { repoRoot } from "./storage/index.js";

const FILE = () => resolve(repoRoot(), "storage", "state", "manual-stops.json");

function read(): Set<string> {
  try {
    const f = FILE();
    if (!existsSync(f)) return new Set();
    const parsed = JSON.parse(readFileSync(f, "utf8")) as { universityIds?: string[] };
    return new Set(parsed.universityIds ?? []);
  } catch {
    return new Set();
  }
}

function write(ids: Set<string>): void {
  try {
    const f = FILE();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ universityIds: [...ids] }, null, 2), "utf8");
  } catch {
    /* best-effort — never fail a crawl over this marker */
  }
}

/** Record that the user deliberately stopped this university's crawl. */
export function markManualStop(universityId: string): void {
  const ids = read();
  if (!ids.has(universityId)) { ids.add(universityId); write(ids); }
}

/** Clear the manual-stop flag (user explicitly resumed / restarted this crawl). */
export function clearManualStop(universityId: string): void {
  const ids = read();
  if (ids.delete(universityId)) write(ids);
}

/** Clear every manual-stop flag (a fresh "crawl all" runs everything). */
export function clearAllManualStops(): void {
  write(new Set());
}

/** Was this university's crawl deliberately stopped by the user? */
export function isManuallyStopped(universityId: string): boolean {
  return read().has(universityId);
}

/** All university ids currently flagged as manually stopped. */
export function manuallyStoppedIds(): Set<string> {
  return read();
}
