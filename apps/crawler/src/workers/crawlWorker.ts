import { Worker, type Job } from "bullmq";
import {
  QUEUE_NAMES,
  getRedisConnection,
  crawlBackoffStrategy,
  enqueueCrawl,
  type CrawlJobPayload,
} from "@clg/queue";
import { env, logger, CrawlContext, JobType, CrawlAction, contextsForTarget, humanizeError } from "@clg/shared";
import { universityRepository, jobRepository } from "@clg/database";
import { runUniversityCrawl } from "../crawl/runCrawl.js";
import { logAction } from "../observability/log.js";

/**
 * CRAWL worker: one job == one university crawl. Concurrency is CRAWL_CONCURRENCY
 * (how many universities run at once); per-domain politeness is handled inside
 * the crawler. Separate from PARSE concurrency (fix #6).
 */
export function startCrawlWorker(): Worker<CrawlJobPayload> {
  const worker = new Worker<CrawlJobPayload>(
    QUEUE_NAMES.CRAWL,
    async (job: Job<CrawlJobPayload>) => {
      const { universityId, crawlJobId } = job.data;
      // One crawl execution == ONE context. Jobs queued before context isolation
      // existed carry none — default them from the configured CRAWL_TARGET (its
      // first context); every request is still re-verified defensively in-run.
      const context: CrawlContext = job.data.context ?? contextsForTarget(env.CRAWL_TARGET)[0]!;
      const university = await universityRepository.findById(universityId);
      if (!university) throw new Error(`University ${universityId} not found`);

      // Ghost QUEUED/RUNNING job rows from crashed/killed runs read as parallel
      // crawls that don't exist and skew the dashboard's ETA — close them now.
      await jobRepository.closeStaleActive(universityId, context, crawlJobId).catch(() => 0);
      await jobRepository.markRunning(crawlJobId);
      await universityRepository.updateCrawlStatus(universityId, "DISCOVERING");

      const result = await runUniversityCrawl(university, crawlJobId, context);

      // HONEST COMPLETION: COMPLETED strictly means "every discovered crawlable
      // page was visited" — verified against the DB (pendingRemaining), never
      // assumed. A run cut short (page budget / stop) is STOPPED, with a clear
      // message in the crawl log, and does NOT advance the context chain: a
      // resume re-runs this context first (completedContexts only counts
      // COMPLETED jobs), so no pending page is ever silently skipped.
      if (result.pendingRemaining > 0) {
        await jobRepository.markStopped(crawlJobId, result as unknown as Record<string, number>);
        await universityRepository.updateCrawlStatus(universityId, "STOPPED");
        await logAction({
          university_id: universityId,
          action: CrawlAction.DISCOVER_LINKS,
          status: "WARN",
          message: `${context} crawl STOPPED before completion — ${result.pagesVisited} pages visited, ${result.validatedTargets} validated, but ${result.pendingRemaining} crawlable page(s) still pending${result.stoppedAtBudget ? ` (page budget MAX_PAGES_PER_UNIVERSITY=${env.MAX_PAGES_PER_UNIVERSITY} reached)` : ""}. NOT marked completed. Click Resume to continue exactly where it left off${result.stoppedAtBudget ? ", or raise the page budget in Settings" : ""}.`,
        }).catch(() => {});
        logger.warn({ universityId, context, ...result }, "crawl stopped with pending work — university marked STOPPED (resume continues)");
        return result;
      }

      await jobRepository.markCompleted(crawlJobId, result as unknown as Record<string, number>);

      // CONTEXT CHAIN: a "both" crawl runs eligibility then scholarship for the
      // SAME university SEQUENTIALLY (never concurrently — see startCrawl's
      // comment for why). Only mark the university COMPLETED once the chain is
      // empty; otherwise hand off to the next context now.
      const [nextContext, ...rest] = job.data.chainNextContexts ?? [];
      if (nextContext) {
        const nextJob = await jobRepository.create({ university_id: universityId, job_type: JobType.DISCOVER, crawl_context: nextContext });
        await enqueueCrawl({ universityId, crawlJobId: nextJob.id, context: nextContext, chainNextContexts: rest.length ? rest : undefined });
        await universityRepository.updateCrawlStatus(universityId, "QUEUED");
        await logAction({
          university_id: universityId,
          action: CrawlAction.DISCOVER_LINKS,
          status: "OK",
          message: `${context} crawl COMPLETE (${result.pagesVisited} pages, ${result.validatedTargets} validated, 0 pending) — continuing with the ${nextContext} crawl next.`,
        }).catch(() => {});
      } else {
        await universityRepository.updateCrawlStatus(universityId, "COMPLETED");
        await logAction({
          university_id: universityId,
          action: CrawlAction.DISCOVER_LINKS,
          status: "OK",
          message: `Crawl COMPLETED — ${result.pagesVisited} pages visited, ${result.validatedTargets} validated target(s), 0 crawlable pages pending. Every discovered page was crawled and validated.`,
        }).catch(() => {});
      }
      logger.info({ universityId, context, nextContext: nextContext ?? null, ...result }, "crawl complete");
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: env.CRAWL_CONCURRENCY,
      settings: { backoffStrategy: crawlBackoffStrategy },
      // A crawl job runs for many minutes. BullMQ AUTO-RENEWS the lock every
      // lockDuration/2 while the worker is alive — but on a LAPTOP the renewal
      // timer misses whenever the machine sleeps or a CPU storm starves the event
      // loop, and every missed renewal stalls the job → re-queue → 2-min restart
      // tax (observed: 52 restart loops without one completion). A 10-min lock
      // rides out sleeps/storms; a dead worker still frees its job within ~10 min
      // and the resume continues exactly where it left off — the right trade for
      // a local single-user engine.
      lockDuration: 600000, // 10 min (auto-renewed during the job)
      stalledInterval: 60000, // check for stalls every 60s
      maxStalledCount: 10, // tolerate many restarts; resume continues the crawl
    },
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const deadLetter = (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 3);
    logger.error(
      { jobId: job.id, attemptsMade: job.attemptsMade, deadLetter, err: err.message },
      "crawl job failed",
    );
    // USER-VISIBLE failure message (crawl log / dashboard) — not just the
    // process log. Plain-English reason + what happens next, every attempt.
    const human = humanizeError(err);
    await logAction({
      university_id: job.data.universityId,
      action: CrawlAction.DISCOVER_LINKS,
      status: "ERROR",
      message: deadLetter
        ? `Crawl FAILED after ${job.attemptsMade} attempt(s): ${human}. University marked FAILED — fix the cause (see message), then Resume to continue where it left off.`
        : `Crawl attempt ${job.attemptsMade} failed: ${human}. Retrying automatically…`,
    }).catch(() => {});
    if (deadLetter) {
      await universityRepository.updateCrawlStatus(job.data.universityId, "FAILED").catch(() => {});
      await jobRepository.markFailed(job.data.crawlJobId, true).catch(() => {});
    }
  });

  // Worker-LEVEL faults (Redis connection drop, an internal BullMQ polling
  // error) are distinct from a single job's 'failed' event above — previously
  // unhandled, so Node routed them wherever an unhandled rejection/exception
  // happens to land (observed live: a silent stop with zero log output,
  // heartbeat still ticking — the Worker's internal poll loop died without
  // ever surfacing here). Logging it explicitly is diagnostic; the process-
  // level stall watchdog in main.ts is the actual backstop that recovers
  // regardless of whether this fires.
  worker.on("error", (err) => {
    logger.error({ err: String(err) }, "crawl worker error (Redis/connection fault) — the stall watchdog will restart if this stops progress");
  });

  return worker;
}
