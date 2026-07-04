import { Queue, type JobsOptions } from "bullmq";
import type { CrawlContext } from "@clg/shared";
import { getRedisConnection } from "./connection.js";

export const QUEUE_NAMES = {
  CRAWL: "clg-crawl",
  PARSE: "clg-parse",
} as const;

/** A university-level crawl: discovery → scoring → validation → extraction → chunking. */
export interface CrawlJobPayload {
  universityId: string;
  /** CrawlJob row id, for progress tracking. */
  crawlJobId: string;
  /** The single objective of THIS crawl execution (eligibility XOR scholarship).
   *  Optional only for jobs queued before context isolation existed — the worker
   *  defaults those to ELIGIBILITY and re-checks every request defensively. */
  context?: CrawlContext;
}

/** A single page snapshot to parse (the LLM-bound stage, throttled separately). */
export interface ParseJobPayload {
  universityId: string;
  snapshotId: string;
  crawlJobId?: string;
  /** Context of the crawl that produced the snapshot. The course-criteria parser
   *  only accepts ELIGIBILITY snapshots (validated individual course pages). */
  context?: CrawlContext;
}

/**
 * Retry policy (Section 37): 3 attempts with 2s / 8s / 30s backoff.
 * Implemented with a custom backoff strategy (registered on each Worker via
 * `settings.backoffStrategy = crawlBackoffStrategy`).
 */
export const RETRY_BACKOFF_MS = [2000, 8000, 30000];

export function crawlBackoffStrategy(attemptsMade: number): number {
  // attemptsMade is 1-based for the first retry.
  const idx = Math.min(attemptsMade - 1, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[idx] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
}

export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "custom" },
  removeOnComplete: { count: 1000 },
  // Keep failed jobs so they can be inspected / moved to the dead-letter set.
  removeOnFail: false,
};

// Return types are intentionally inferred: BullMQ's `Queue<T>` annotation does
// not match `new Queue<T>(...)` instance type (ExtractDataType generics), so we
// let inference carry the exact instance type.
function createCrawlQueue() {
  return new Queue<CrawlJobPayload>(QUEUE_NAMES.CRAWL, {
    connection: getRedisConnection(),
    defaultJobOptions,
  });
}
function createParseQueue() {
  return new Queue<ParseJobPayload>(QUEUE_NAMES.PARSE, {
    connection: getRedisConnection(),
    defaultJobOptions,
  });
}

let crawlQueue: ReturnType<typeof createCrawlQueue> | undefined;
let parseQueue: ReturnType<typeof createParseQueue> | undefined;

export function getCrawlQueue() {
  crawlQueue ??= createCrawlQueue();
  return crawlQueue;
}

export function getParseQueue() {
  parseQueue ??= createParseQueue();
  return parseQueue;
}

// NOTE: BullMQ custom job IDs must NOT contain ":" (it is the Redis key
// separator). Use "-" so enqueue never throws "Custom Id cannot contain :".
//
// jobId is keyed by UNIVERSITY + CONTEXT (not the per-call crawlJobId) so a
// crawl is IDEMPOTENT per context: re-queuing a university whose crawl for that
// context is already running is a no-op (no duplicate concurrent crawls), while
// the ELIGIBILITY and SCHOLARSHIP executions of one university remain separate
// jobs. A finished/failed job is cleared first so a fresh crawl can start.
export async function enqueueCrawl(payload: CrawlJobPayload) {
  const jobId = `crawl-${payload.universityId}-${(payload.context ?? "ELIGIBILITY").toLowerCase()}`;
  const q = getCrawlQueue();
  try {
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "active" || state === "waiting" || state === "delayed") return existing; // already queued/running
      await existing.remove(); // completed/failed → clear so we can re-crawl
    }
  } catch { /* ignore — fall through to add */ }
  return q.add("crawl", payload, { jobId });
}

/** Remove ALL crawl jobs (waiting + active + completed + failed). Used to clear
 *  a stuck/duplicated queue before a clean restart. */
export async function obliterateCrawlQueue() {
  await getCrawlQueue().obliterate({ force: true });
}

/**
 * Backlog the engine still owns: crawl + parse jobs that are waiting, active,
 * delayed or paused (NOT completed/failed leftovers). The API uses
 * `total === 0` — together with "no active universities" — to know a crawl has
 * fully finished and the idle engine can be stopped. */
export async function getEngineBacklog(): Promise<{ crawl: number; parse: number; total: number }> {
  const sum = (c: { [index: string]: number }) =>
    (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0) + (c.paused ?? 0);
  const [c, p] = await Promise.all([
    getCrawlQueue().getJobCounts("waiting", "active", "delayed", "paused"),
    getParseQueue().getJobCounts("waiting", "active", "delayed", "paused"),
  ]);
  const crawl = sum(c);
  const parse = sum(p);
  return { crawl, parse, total: crawl + parse };
}

export async function enqueueParse(payload: ParseJobPayload) {
  // jobId keyed by snapshot makes enqueue idempotent (resumable, no dupes).
  return getParseQueue().add("parse", payload, {
    jobId: `parse-${payload.snapshotId}`,
  });
}
