import { logger, manuallyStoppedIds } from "@clg/shared";
import { getEngineBacklog } from "@clg/queue";
import { prisma } from "@clg/database";
import { getCrawlProgress } from "./crawlAdminService.js";
import { getCrawlerState, restartCrawler, stopCrawler } from "./crawlerControlService.js";
import { recoverCrawl, startCrawl } from "./crawlService.js";

/**
 * API-side STALL WATCHDOG — makes the crawl self-heal.
 *
 * The process watchdog (crawlerControlService) relaunches the engine when it
 * CRASHES, but a relaunched engine has no work: the in-flight BullMQ job is lost,
 * so the university sits in DISCOVERING with nothing processing it. This watchdog
 * watches for exactly that — engine "running" but no pages crawled for a while —
 * and RE-ENQUEUES the incomplete universities so the crawl actually continues.
 *
 * Escalation: first stall → re-enqueue (cheap). If it's STILL stalled next cycle →
 * also restart the engine (clears a wedged browser pool), then re-enqueue. Rate-
 * limited so a genuinely broken environment (e.g. out of memory) can't loop
 * forever — after the cap we stop and the dashboard tells the user to intervene.
 *
 * It ALSO auto-stops the engine when a crawl FINISHES: once a crawl we watched run
 * has fully drained (nothing active AND both queues empty) the engine is just
 * holding browsers open with nothing to do, so we stop it — that's why the live
 * status can read "complete + engine idle" instead of staying "running" forever.
 * (Set AUTO_STOP_WHEN_DONE=false to keep the old "always ready and waiting" engine.)
 */
const CHECK_INTERVAL_MS = 30_000; // how often we look for a stall / a finished crawl
const RECOVER_COOLDOWN_MS = 4 * 60_000; // min gap between auto-recoveries
const MAX_RECOVERS_PER_HOUR = 5; // give up (let the user act) after this many

let timer: NodeJS.Timeout | null = null;
let lastRecoverAt = 0;
let recoverCount = 0;
let windowStart = Date.now();
let escalated = false; // a re-enqueue was already tried for the current stall
let sawActiveWork = false; // a crawl actually ran this engine-life → safe to auto-stop when it drains

/** Snapshot for the dashboard so the stall card can show what auto-recovery did. */
export function getAutoRecoverInfo() {
  return {
    enabled: recoverCount < MAX_RECOVERS_PER_HOUR,
    recoverCount,
    lastRecoverAt: lastRecoverAt ? new Date(lastRecoverAt).toISOString() : null,
  };
}

async function tick() {
  try {
    // Hourly window reset for the rate limiter.
    if (Date.now() - windowStart > 3_600_000) {
      windowStart = Date.now();
      recoverCount = 0;
    }

    const progress = await getCrawlProgress();
    const running = getCrawlerState().running;

    // Remember a crawl was actually running this engine-life, so we only auto-stop
    // an engine that FINISHED work — never the fresh "ready & waiting" engine that
    // the app starts before the user has queued anything.
    if (progress.activeRemaining > 0) sawActiveWork = true;

    // --- V4 AUTO-RESUME CHECK ---
    // Check for universities that hit their page budget (STOPPED) or crashed (FAILED)
    // but still have pending work. If they weren't manually stopped, resume them!
    const skipIds = manuallyStoppedIds();
    const stoppedToResume = await prisma.$queryRawUnsafe<{ id: string; pending: number }[]>(
      `SELECT u.id, count(dl.id)::int AS pending
       FROM university u
       JOIN discovered_link dl ON dl.university_id = u.id
       WHERE u.crawl_status IN ('STOPPED', 'FAILED')
         AND dl.http_status IS NULL AND dl.status = 'QUEUED'
       GROUP BY u.id
       HAVING count(dl.id) > 0`
    );

    for (const row of stoppedToResume) {
      if (skipIds.has(row.id)) continue; // skip manually stopped
      logger.info({ universityId: row.id, pending: row.pending }, "V4 auto-resume: re-queuing stopped/failed university with pending work");
      await startCrawl(row.id).catch((e) => logger.error({ err: String(e) }, "auto-resume failed"));
    }

    const stalled = running && progress.stalled && progress.activeRemaining > 0;
    if (!stalled) {
      escalated = false; // healthy again — reset escalation for the next stall
      // SELF-STOP: the crawl has fully finished (nothing active) and we watched it
      // run — stop the idle engine once BOTH queues are truly empty, so it isn't
      // left "running" with no work (and frees the browser memory).
      if (running && sawActiveWork && progress.activeRemaining === 0 && process.env.AUTO_STOP_WHEN_DONE !== "false") {
        const backlog = await getEngineBacklog();
        if (backlog.total === 0) {
          sawActiveWork = false;
          logger.info("crawl complete — nothing active and the queue is empty; stopping the idle engine");
          await stopCrawler();
        }
      }
      return;
    }
    if (Date.now() - lastRecoverAt < RECOVER_COOLDOWN_MS) return; // just tried — give it time
    if (recoverCount >= MAX_RECOVERS_PER_HOUR) return; // capped — surfaced in the UI for the user

    if (!escalated) {
      logger.warn({ activeRemaining: progress.activeRemaining }, "crawl stalled — auto-recovering (re-enqueue incomplete universities)");
      await recoverCrawl();
      escalated = true;
    } else {
      logger.warn("crawl still stalled — escalating to engine restart + re-enqueue");
      await restartCrawler();
      await recoverCrawl();
      escalated = false;
    }
    lastRecoverAt = Date.now();
    recoverCount += 1;
  } catch (err) {
    logger.error({ err: String(err) }, "stall watchdog tick failed");
  }
}

export function startStallWatchdog() {
  if (timer) return;
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref?.(); // never keep the process alive just for the watchdog
  logger.info("crawl stall watchdog started");
}
