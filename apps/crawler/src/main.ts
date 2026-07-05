import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger, loadEnv, repoRoot } from "@clg/shared";
import { closeRedisConnection } from "@clg/queue";
import { prisma } from "@clg/database";
import { startCrawlWorker } from "./workers/crawlWorker.js";
import { startParseWorker } from "./workers/parseWorker.js";

// Heartbeat lock so the dashboard can detect the engine no matter how it was
// started (dashboard child OR start.bat / run-crawler.bat). It writes {pid,ts}
// every few seconds and removes the file on a clean exit; the API treats a lock
// whose ts is older than ~20s as "engine not running".
const LOCK = resolve(repoRoot(), "storage", "crawler.lock");
function writeHeartbeat() {
  try {
    mkdirSync(resolve(repoRoot(), "storage"), { recursive: true });
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf8");
  } catch {
    /* non-fatal */
  }
}
function clearHeartbeat() {
  try { rmSync(LOCK, { force: true }); } catch { /* ignore */ }
}

/** Crawler service entry: runs the CRAWL + PARSE BullMQ workers. */
async function main() {
  loadEnv(); // fail fast on bad config
  logger.info("starting crawler workers…");

  const crawlWorker = startCrawlWorker();
  const parseWorker = startParseWorker();

  writeHeartbeat();
  const heartbeat = setInterval(writeHeartbeat, 5000);

  logger.info("crawler workers ready (crawl + parse)");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down crawler…");
    clearInterval(heartbeat);
    clearHeartbeat();
    await Promise.allSettled([crawlWorker.close(), parseWorker.close()]);
    await closeRedisConnection();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("exit", clearHeartbeat);

  // RESILIENCE AT SCALE: with CRAWL_CONCURRENCY > 1, every parallel university
  // crawl runs inside THIS one process. Node's default for an unhandled promise
  // rejection is to terminate the whole process — so one transient DB/network
  // hiccup in ANY single crawl (observed live: a Postgres container restart)
  // used to kill ALL concurrent crawls together, discarding no data (progress
  // lives in Postgres, resumable) but wasting the whole in-flight batch and
  // the time to notice + relaunch. Log and keep serving the other crawls
  // instead — each university's own error handling (failedRequestHandler,
  // the crawl's try/catch) already contains failures that ARE properly
  // caught; this is a last-resort net for ones that slip through.
  process.on("unhandledRejection", (err) => {
    logger.error({ err: String(err) }, "unhandled rejection — logged, engine continues serving other crawls");
  });
  // A genuinely thrown (non-promise) error is more likely to leave shared
  // state (e.g. a half-initialized browser pool) inconsistent, so here we
  // exit deliberately rather than limp on — the process supervisor
  // (crawlerControlService's backoff relaunch, or run-crawler.bat's loop)
  // restarts a clean process and every crawl resumes exactly where it left
  // off (Postgres-backed resume state), so this costs seconds, not progress.
  process.on("uncaughtException", (err) => {
    logger.error({ err: String(err) }, "uncaught exception — restarting for a clean state (all crawls resume)");
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error({ err: String(err) }, "crawler failed to start");
  process.exit(1);
});
