import { Worker, type Job } from "bullmq";
import {
  QUEUE_NAMES,
  getRedisConnection,
  crawlBackoffStrategy,
  type ParseJobPayload,
} from "@clg/queue";
import { env, logger } from "@clg/shared";
import { runParseSnapshot } from "../parse/runParse.js";

/**
 * PARSE worker: one job == one page snapshot through the LLM/rule pipeline.
 * Throttled by PARSE_CONCURRENCY, independent of crawl concurrency, because
 * local-model parsing is the system bottleneck (fix #6).
 */
export function startParseWorker(): Worker<ParseJobPayload> {
  const worker = new Worker<ParseJobPayload>(
    QUEUE_NAMES.PARSE,
    async (job: Job<ParseJobPayload>) => {
      // CONTEXT GUARD: the course-criteria parser only accepts ELIGIBILITY
      // snapshots (validated individual course pages). A scholarship-context
      // parse job should never be produced — if one appears (stale queue, wrong
      // producer), skip it instead of polluting CourseCriteria.
      if (job.data.context === "SCHOLARSHIP") {
        logger.warn({ snapshotId: job.data.snapshotId }, "parse job skipped: SCHOLARSHIP context never reaches the course-criteria parser");
        return { stored: 0, duplicates: 0, filter_rate: 0, parser_used: "none(cross-context)" };
      }
      const result = await runParseSnapshot(job.data.snapshotId);
      logger.debug({ snapshotId: job.data.snapshotId, ...result }, "parse complete");
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: env.PARSE_CONCURRENCY,
      settings: { backoffStrategy: crawlBackoffStrategy },
    },
  );

  worker.on("failed", (job, err) => {
    const deadLetter = job ? (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 3) : false;
    logger.error(
      { jobId: job?.id, attemptsMade: job?.attemptsMade, deadLetter, err: err.message },
      "parse job failed",
    );
  });

  // Worker-level faults (Redis connection drop, internal BullMQ error) — see
  // the identical handler on the crawl worker for why this matters.
  worker.on("error", (err) => {
    logger.error({ err: String(err) }, "parse worker error (Redis/connection fault)");
  });

  return worker;
}
