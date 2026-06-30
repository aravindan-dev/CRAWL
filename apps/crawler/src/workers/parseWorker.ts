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

  return worker;
}
