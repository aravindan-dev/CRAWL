import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { parseString } from "fast-csv";
import { repoRoot, getKeywords, keywordsToRegex } from "@clg/shared";

/**
 * CHANGE MONITOR — the recurring-value engine. University entry requirements and
 * scholarships change every year, links break and pages move. This re-checks
 * every URL the customer exported, fingerprints its eligibility/funding content,
 * and reports what is NEW / CHANGED / BROKEN / FIXED since the last check — so the
 * data they pushed to their CRM stays current (and they keep paying to keep it so).
 */
const EXPORT_DIR = resolve(repoRoot(), "storage", "exports");
const STATE_PATH = resolve(repoRoot(), "storage", "monitor.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const kw = getKeywords();
const EVIDENCE = keywordsToRegex([...kw.evidence, ...kw.scholarship]);

export type ChangeType = "NEW" | "CHANGED" | "BROKEN" | "FIXED";
interface Fingerprint { hash: string; status: "OK" | "BROKEN"; university: string; kind: string; firstSeen: string; lastChecked: string }
export interface Change { url: string; type: ChangeType; university: string; kind: string; at: string; note: string }
interface MonitorState { lastRun: string | null; fingerprints: Record<string, Fingerprint>; changes: Change[] }

function loadState(): MonitorState {
  try { if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as MonitorState; } catch { /* ignore */ }
  return { lastRun: null, fingerprints: {}, changes: [] };
}
function saveState(s: MonitorState) {
  mkdirSync(resolve(repoRoot(), "storage"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), "utf8");
}

interface Target { university: string; url: string; kind: string }

/** Read {university, url} from one export CSV (robust to column names). */
function readCsv(file: string, kind: string): Promise<Target[]> {
  const path = join(EXPORT_DIR, file);
  return new Promise((resolveP) => {
    if (!existsSync(path)) return resolveP([]);
    const out: Target[] = [];
    parseString(readFileSync(path, "utf8"), { headers: true, ignoreEmpty: true, trim: true })
      .on("error", () => resolveP(out))
      .on("data", (row: Record<string, string>) => {
        const keys = Object.keys(row);
        const urlKey = keys.find((k) => /url/i.test(k) && /\S/.test(row[k] ?? ""));
        const uniKey = keys.find((k) => /universit/i.test(k));
        const url = urlKey ? (row[urlKey] ?? "").trim() : "";
        if (/^https?:\/\//i.test(url)) out.push({ university: uniKey ? (row[uniKey] ?? "").trim() : "", url, kind });
      })
      .on("end", () => resolveP(out));
  });
}

async function fingerprint(url: string): Promise<{ status: "OK" | "BROKEN"; hash: string }> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: c.signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" } });
    if (res.status < 200 || res.status >= 300) { try { await res.body?.cancel(); } catch { /* ignore */ } return { status: "BROKEN", hash: "" }; }
    const text = (await res.text())
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase();
    // Hash only the eligibility/funding-relevant sentences, so cosmetic/nav
    // changes don't cause noise — only real requirement/scholarship edits do.
    const relevant = text.split(/(?<=[.!?])\s/).filter((s) => EVIDENCE.test(s)).join(" ") || text.slice(0, 4000);
    return { status: "OK", hash: createHash("sha256").update(relevant).digest("hex").slice(0, 32) };
  } catch {
    return { status: "BROKEN", hash: "" };
  } finally {
    clearTimeout(t);
  }
}

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

interface MonProgress { running: boolean; done: number; total: number; changed: number; broken: number; newly: number; fixed: number }
let mon: MonProgress = { running: false, done: 0, total: 0, changed: 0, broken: 0, newly: 0, fixed: 0 };
export const getMonitorProgress = (): MonProgress => mon;

/** Re-check every exported URL and record NEW / CHANGED / BROKEN / FIXED. */
export async function runMonitor(): Promise<{ started: boolean; total: number }> {
  if (mon.running) return { started: false, total: mon.total };
  const targets = (
    await Promise.all([
      readCsv("eligibility-UNIVERSITY-INTERNATIONAL-FINAL.csv", "university eligibility"),
      readCsv("eligibility-COURSES-INTERNATIONAL-FINAL.csv", "course eligibility"),
      readCsv("scholarships-INTERNATIONAL-FINAL.csv", "scholarship"),
    ])
  ).flat();
  // Dedupe by URL.
  const byUrl = new Map<string, Target>();
  for (const t of targets) if (!byUrl.has(t.url)) byUrl.set(t.url, t);
  const list = [...byUrl.values()];

  mon = { running: true, done: 0, total: list.length, changed: 0, broken: 0, newly: 0, fixed: 0 };
  void (async () => {
    const state = loadState();
    const now = new Date().toISOString();
    const runChanges: Change[] = [];
    await pool(list, 8, async (t) => {
      try {
        const fp = await fingerprint(t.url);
        const prev = state.fingerprints[t.url];
        let type: ChangeType | null = null;
        if (!prev) { if (fp.status === "OK") { type = "NEW"; mon.newly += 1; } else { type = "BROKEN"; mon.broken += 1; } }
        else if (fp.status === "BROKEN" && prev.status === "OK") { type = "BROKEN"; mon.broken += 1; }
        else if (fp.status === "OK" && prev.status === "BROKEN") { type = "FIXED"; mon.fixed += 1; }
        else if (fp.status === "OK" && prev.status === "OK" && fp.hash !== prev.hash) { type = "CHANGED"; mon.changed += 1; }
        if (type) runChanges.push({ url: t.url, type, university: t.university, kind: t.kind, at: now, note: type === "BROKEN" ? "Page no longer reachable / removed" : type === "CHANGED" ? "Requirements/scholarship content changed" : type === "FIXED" ? "Page is reachable again" : "Newly tracked URL" });
        state.fingerprints[t.url] = { hash: fp.hash, status: fp.status, university: t.university, kind: t.kind, firstSeen: prev?.firstSeen ?? now, lastChecked: now };
      } catch { /* skip */ }
      mon.done += 1;
    });
    state.lastRun = now;
    // Keep the most recent 1000 change records (newest first).
    state.changes = [...runChanges, ...state.changes].slice(0, 1000);
    saveState(state);
    mon = { ...mon, running: false };
  })();
  return { started: true, total: list.length };
}

/** Dashboard summary: counts + recent changes. */
export function getMonitorSummary(): {
  lastRun: string | null; tracked: number; ok: number; broken: number;
  recent: Change[]; sinceLastRun: { NEW: number; CHANGED: number; BROKEN: number; FIXED: number };
} {
  const s = loadState();
  const fps = Object.values(s.fingerprints);
  const lastRunChanges = s.lastRun ? s.changes.filter((c) => c.at === s.lastRun) : [];
  const tally = (t: ChangeType) => lastRunChanges.filter((c) => c.type === t).length;
  return {
    lastRun: s.lastRun,
    tracked: fps.length,
    ok: fps.filter((f) => f.status === "OK").length,
    broken: fps.filter((f) => f.status === "BROKEN").length,
    recent: s.changes.slice(0, 200),
    sinceLastRun: { NEW: tally("NEW"), CHANGED: tally("CHANGED"), BROKEN: tally("BROKEN"), FIXED: tally("FIXED") },
  };
}
