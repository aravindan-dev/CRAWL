import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { logger, loadEnv, repoRoot, env, contextsForTarget, manuallyStoppedIds } from "@clg/shared";
import { closeRedisConnection, obliterateCrawlQueue, enqueueCrawl, getCrawlQueue } from "@clg/queue";
import { prisma, jobRepository } from "@clg/database";
import { checkLicense } from "@clg/license";
import { startCrawlWorker } from "./workers/crawlWorker.js";
import { startParseWorker } from "./workers/parseWorker.js";
import { startAdaptiveConcurrency } from "./workers/adaptiveConcurrency.js";

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

/**
 * SELF-HEAL ON BOOT: whenever the crawler process starts (dashboard restart,
 * a crash relaunch, a machine reboot, run-crawler.bat's watch loop), any
 * university crawl that was mid-flight in the PREVIOUS process instance is
 * still holding an "active" BullMQ job — but that job's worker lock only
 * expires after lockDuration (10 min; see crawlWorker.ts) unless something
 * proactively clears it. Left alone, the fresh worker sits completely idle
 * for up to 10 minutes before BullMQ's own stalled-job check reassigns the
 * work (observed live, twice, during this session's own restarts — a real,
 * repeated efficiency loss on every non-graceful shutdown).
 *
 * The API already has a trusted fix for exactly this (crawlService.ts's
 * resumeCrawlAll: obliterate the crawl queue's stale state, then re-enqueue
 * every not-yet-COMPLETED university) — but it only runs reactively, via the
 * stall watchdog's multi-minute grace period or a manual dashboard click.
 * Running the SAME operation here, once, at boot, makes recovery instant and
 * makes the crawler self-sufficient regardless of whether the API/watchdog
 * is even running. Safe: obliterate only clears BullMQ scheduling state
 * (Postgres progress is untouched and this crawl is fully resumable —
 * verified live this session), enqueueCrawl's deterministic jobId prevents
 * duplicate concurrent jobs for the same (university, context), and a
 * genuinely idle system (no incomplete universities) skips this entirely.
 */
async function selfHealIncompleteCrawls(): Promise<void> {
  const rows = await prisma.university.findMany({
    where: { crawl_status: { not: "COMPLETED" }, base_url: { not: "" } },
    select: { id: true },
  });
  // AUTO-resume respects manual stops: a university the user deliberately stopped
  // is NOT re-enqueued on engine boot — it only runs again on an explicit Resume/
  // start. Auto-stopped crawls (page budget, incomplete run, crash) have no flag,
  // so they DO auto-resume, exactly as before.
  const manuallyStopped = manuallyStoppedIds();
  const incomplete = rows.filter((u) => !manuallyStopped.has(u.id));
  if (incomplete.length === 0) return;

  await obliterateCrawlQueue();
  const contexts = contextsForTarget(env.CRAWL_TARGET);
  let n = 0;
  // Context-outer ordering (Round 7): parallel workers land on DIFFERENT
  // universities from the very first job after a restart, not just when
  // enqueue-all.ts is run by hand.
  for (const context of contexts) {
    for (const u of incomplete) {
      const job = await jobRepository.create({ university_id: u.id, job_type: "DISCOVER", crawl_context: context });
      await enqueueCrawl({ universityId: u.id, crawlJobId: job.id, context });
      n += 1;
    }
  }
  logger.info(
    { universities: incomplete.length, jobsEnqueued: n, contexts },
    "self-heal: resumed incomplete crawls from the last Postgres-recorded page",
  );
}

/**
 * INTERNAL STALL WATCHDOG: covers a failure mode the boot-time self-heal
 * above CANNOT — a Worker that goes silently unresponsive mid-run (observed
 * live: the crawl log went dead with zero error/crash output while the
 * process itself stayed alive and kept writing its heartbeat; likely an
 * ioredis command that hung on a half-open connection rather than erroring,
 * so nothing ever reached the unhandledRejection/uncaughtException handlers
 * below to trigger a restart). Deliberately failure-mode-agnostic: it never
 * inspects WHY, only WHETHER real progress is happening.
 *
 * Signal: BullMQ reports active/waiting crawl jobs (work is supposed to be
 * happening) AND no discovered_link row has been written in STALL_GRACE_MS.
 * On a genuine stall it just exits — the external supervisor
 * (crawlerControlService's backoff relaunch, or run-crawler.bat's loop)
 * relaunches a clean process, and selfHealIncompleteCrawls() on THAT boot
 * clears the dead job lock and resumes immediately (both proven live this
 * session). This watchdog only ever calls process.exit — it never touches
 * BullMQ/DB state directly, so it cannot race the API's own (separate,
 * reactive) stall watchdog; both converging on the same restart is fine.
 */
const STALL_GRACE_MS = 6 * 60_000; // generous: a real crawl always writes far more often than this
const STALL_CHECK_INTERVAL_MS = 90_000;

function startStallWatchdog(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void (async () => {
      try {
        const [crawlCounts, lastLink] = await Promise.all([
          getCrawlQueue().getJobCounts("active", "waiting"),
          prisma.discoveredLink.findFirst({ orderBy: { updated_at: "desc" }, select: { updated_at: true } }),
        ]);
        const expectingWork = (crawlCounts.active ?? 0) + (crawlCounts.waiting ?? 0) > 0;
        if (!expectingWork) return; // idle system — silence is normal, not a stall
        const sinceLastWrite = lastLink ? Date.now() - lastLink.updated_at.getTime() : Infinity;
        if (sinceLastWrite < STALL_GRACE_MS) return;
        logger.error(
          { activeJobs: crawlCounts.active, waitingJobs: crawlCounts.waiting, sinceLastWriteMs: sinceLastWrite },
          `stall watchdog: work is queued but no page written in ${Math.round(sinceLastWrite / 1000)}s — exiting for a clean relaunch (crawls resume from the last recorded page)`,
        );
        process.exit(1);
      } catch (err) {
        // A failed CHECK must never itself crash the engine.
        logger.warn({ err: String(err) }, "stall watchdog check failed — will retry next interval");
      }
    })();
  }, STALL_CHECK_INTERVAL_MS);
}

/** Crawler service entry: runs the CRAWL + PARSE BullMQ workers. */
/**
 * LICENSE GATE — jobs never run unlicensed. Unlike the API (which stays up to
 * show the lock screen), a crawl worker has no UI to show, so an invalid/expired
 * license just logs one plain-English line and exits non-zero.
 */
function requireLicenseOrExit(): void {
  const status = checkLicense(join(repoRoot(), "storage"));
  if (status.state === "invalid") {
    logger.error({ code: status.code }, `${status.message} Crawl workers will not start unlicensed.`);
    process.exit(2);
  }
  if (status.state === "grace") {
    logger.warn({ graceDaysLeft: status.graceDaysLeft }, "license expired — running in grace period");
  }
}

async function main() {
  loadEnv(); // fail fast on bad config
  requireLicenseOrExit();
  logger.info("starting crawler workers…");

  await selfHealIncompleteCrawls().catch((err) => {
    // Self-heal is a boot-time convenience, not a correctness requirement —
    // the watchdog's own (slower) recovery still applies if this fails.
    logger.warn({ err: String(err) }, "self-heal on boot failed — the stall watchdog will still recover incomplete crawls");
  });

  const crawlWorker = startCrawlWorker();
  const parseWorker = startParseWorker();

  writeHeartbeat();
  const heartbeat = setInterval(writeHeartbeat, 5000);
  const stallWatchdog = startStallWatchdog();

  // ADAPTIVE UNIVERSITY CONCURRENCY (opt-in): scale crawlWorker.concurrency
  // between CRAWL_CONCURRENCY and CRAWL_CONCURRENCY_MAX based on live RAM/CPU
  // headroom + queued work, instead of a fixed worker count. The DB pool is
  // pre-sized for the ceiling (client.ts), so scaling up is connection-safe.
  const stopAdaptive = env.CRAWL_ADAPTIVE_CONCURRENCY
    ? startAdaptiveConcurrency(
        crawlWorker,
        {
          min: env.CRAWL_CONCURRENCY,
          max: Math.max(env.CRAWL_CONCURRENCY, env.CRAWL_CONCURRENCY_MAX),
          step: 5,
          lowMemRatio: 0.12,
          highMemRatio: 0.3,
          highLoadPerCpu: 0.9,
        },
        async () => {
          const c = await getCrawlQueue().getJobCounts("active", "waiting");
          return (c.active ?? 0) + (c.waiting ?? 0);
        },
      )
    : () => {};

  logger.info("crawler workers ready (crawl + parse)");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down crawler…");
    clearInterval(heartbeat);
    clearInterval(stallWatchdog);
    stopAdaptive();
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
