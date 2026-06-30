import { Worker, type Job } from "bullmq";
import {
  QUEUE_NAMES,
  getRedisConnection,
  crawlBackoffStrategy,
  type CrawlJobPayload,
} from "@clg/queue";
import { env, logger } from "@clg/shared";
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
      const university = await universityRepository.findById(universityId);
      if (!university) throw new Error(`University ${universityId} not found`);

      await jobRepository.markRunning(crawlJobId);
      await universityRepository.updateCrawlStatus(universityId, "DISCOVERING");

      const result = await runUniversityCrawl(university, crawlJobId);

      await universityRepository.updateCrawlStatus(universityId, "COMPLETED");
      await jobRepository.markCompleted(crawlJobId, result as unknown as Record<string, number>);
      logger.info({ universityId, ...result }, "crawl complete");
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: env.CRAWL_CONCURRENCY,
      settings: { backoffStrategy: crawlBackoffStrategy },
      // A crawl job runs for many minutes. BullMQ AUTO-RENEWS the lock every
      // lockDuration/2 while the worker is alive (the crawl's page ops are async,
      // so the event loop stays free to renew) — so a moderate 2-min lock keeps
      // long jobs alive. Kept short enough that if a worker dies/restarts, its
      // jobs free up within ~2 min for another worker to RESUME (not 10 min).
      lockDuration: 120000, // 2 min (auto-renewed during the job)
      stalledInterval: 30000, // check for stalls every 30s
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

  return worker;
}
