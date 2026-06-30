import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createWriteStream, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { repoRoot } from "@clg/shared";

/**
 * Manage the crawler+parse worker so the dashboard can Start / Stop / Restart it
 * in one click (restart is how new browser-count / AI settings take effect, since
 * BullMQ fixes worker concurrency at startup).
 *
 * The engine may be started by us (this child `proc`) OR externally (start.bat /
 * run-crawler.bat). To report an accurate status either way, the crawler writes a
 * heartbeat lock (storage/crawler.lock = {pid, ts}); we treat a lock fresher than
 * ~20s as "running" and can stop it by its pid. This is what makes the live
 * monitor show activity no matter how the engine was launched.
 */
let proc: ChildProcess | null = null;
let intentionalStop = false; // true while a Stop/Restart is in progress (don't auto-revive)
let crashRestarts = 0; // consecutive auto-restarts (rate-limited so we don't loop forever)
let lastCrashAt = 0;
const LOCK = resolve(repoRoot(), "storage", "crawler.lock");
const HEARTBEAT_MAX_AGE_MS = 20000;

function readLock(): { pid: number; ts: number } | null {
  try {
    if (!existsSync(LOCK)) return null;
    const data = JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number; ts: number };
    if (typeof data.pid === "number" && Date.now() - data.ts < HEARTBEAT_MAX_AGE_MS) return data;
  } catch {
    /* ignore malformed lock */
  }
  return null;
}

export function getCrawlerState() {
  const owned = Boolean(proc && proc.exitCode === null && !proc.killed);
  if (owned) return { running: true, pid: proc?.pid ?? null };
  // Fall back to the heartbeat lock for an engine we didn't spawn (start.bat etc.)
  const lock = readLock();
  if (lock) return { running: true, pid: lock.pid };
  return { running: false, pid: null };
}

export function startCrawler() {
  if (getCrawlerState().running) return getCrawlerState(); // already running (ours or external)
  intentionalStop = false;
  rmSync(LOCK, { force: true }); // clear any stale lock before a fresh start
  mkdirSync(resolve(repoRoot(), "storage"), { recursive: true });
  // Log to file is best-effort — never let a locked log file block the engine.
  let out: ReturnType<typeof createWriteStream> | null = null;
  try { out = createWriteStream(resolve(repoRoot(), "storage", "crawler.log"), { flags: "a" }); } catch { /* ignore */ }
  const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" };
  if (process.env.PACKAGED === "true") {
    // Packaged build: run the bundled, minified crawler with the portable node.
    // repoRoot() is the runtime dir (STORAGE_ROOT), so the bundle is at crawler/main.cjs.
    const cwd = resolve(repoRoot(), "crawler");
    proc = spawn(process.execPath, [resolve(cwd, "main.cjs")], { cwd, env });
  } else {
    // Dev: run the TypeScript source via tsx.
    proc = spawn("corepack pnpm@9.12.0 exec tsx src/main.ts", {
      cwd: resolve(repoRoot(), "apps", "crawler"),
      shell: true,
      env,
    });
  }
  if (out) { proc.stdout?.pipe(out); proc.stderr?.pipe(out); }
  proc.on("exit", () => {
    proc = null;
    // WATCHDOG: if the engine wasn't stopped on purpose it crashed (commonly an
    // out-of-memory Chromium kill on a small machine). Auto-restart with backoff so
    // the crawl SELF-HEALS and resumes — instead of silently getting stuck.
    if (intentionalStop) return;
    const now = Date.now();
    if (now - lastCrashAt > 90000) crashRestarts = 0; // ran a while → reset the counter
    crashRestarts += 1;
    lastCrashAt = now;
    if (crashRestarts <= 8) {
      const delay = Math.min(30000, 4000 * crashRestarts); // 4s, 8s, … up to 30s
      setTimeout(() => { if (!intentionalStop && !getCrawlerState().running) startCrawler(); }, delay);
    }
    // After 8 rapid crashes we stop reviving; the dashboard shows "stalled" so the
    // user knows to free memory / lower the browser count before retrying.
  });
  return getCrawlerState();
}

function killTree(pid: number): Promise<void> {
  return new Promise((res) => {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"]).on("close", () => res());
    } else {
      try {
        process.kill(-pid);
      } catch {
        /* already gone */
      }
      res();
    }
  });
}

export async function stopCrawler() {
  intentionalStop = true; // tell the watchdog NOT to auto-revive
  crashRestarts = 0;
  const pid = proc?.pid ?? readLock()?.pid ?? null; // stop ours OR an external engine
  proc = null;
  if (pid) await killTree(pid);
  rmSync(LOCK, { force: true });
  return { running: false, pid: null };
}

export async function restartCrawler() {
  await stopCrawler();
  await new Promise((r) => setTimeout(r, 2500));
  return startCrawler();
}
