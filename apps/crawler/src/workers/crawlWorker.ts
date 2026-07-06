import { Worker, type Job } from "bullmq";
import {
  QUEUE_NAMES,
  getRedisConnection,
  crawlBackoffStrategy,
  type CrawlJobPayload,
} from "@clg/queue";
import { env, logger, CrawlContext, contextsForTarget } from "@clg/shared";
import { universityRepository, jobRepository } from "@clg/database";
import { runUniversityCrawl } from "../crawl/runCrawl.js";

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

      await jobRepository.markRunning(crawlJobId);
      await universityRepository.updateCrawlStatus(universityId, "DISCOVERING");

      const result = await runUniversityCrawl(university, crawlJobId, context);

      await universityRepository.updateCrawlStatus(universityId, "COMPLETED");
      await jobRepository.markCompleted(crawlJobId, result as unknown as Record<string, number>);
      logger.info({ universityId, context, ...result }, "crawl complete");
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
