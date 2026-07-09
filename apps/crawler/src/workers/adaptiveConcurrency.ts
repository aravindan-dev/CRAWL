/**
 * ADAPTIVE UNIVERSITY CONCURRENCY — scale the crawl worker between a floor and a
 * ceiling based on live system resources, instead of blindly pinning 20 workers.
 *
 * The crawl worker's `concurrency` is how many universities run at once. Each one
 * costs RAM (fast-lane buffers + its own Playwright browser for escalations) and
 * DB connections. On a small machine 20 parallel full crawls swap-thrash; on a
 * big one 5 leaves throughput on the table. So we START at the floor and step UP
 * only while free RAM (and CPU load, where the OS reports it) leave headroom AND
 * there is queued work waiting — and step DOWN immediately under memory pressure
 * (backpressure / memory protection). The DB pool is sized for the ceiling at
 * startup (see packages/database/src/client.ts) so a scale-up can't exhaust
 * connections; the browser cost is bounded because the browser lane only handles
 * the ~10-15% of pages that truly need it and reuses one browser per crawl.
 *
 * The decision function is pure and unit-tested; the runner just samples and
 * applies it on an interval.
 */
import os from "node:os";
import type { Worker } from "bullmq";
import { logger } from "@clg/shared";

export interface ResourceSample {
  /** os.freemem / os.totalmem — the memory headroom signal. */
  freeMemRatio: number;
  /** 1-min load average / CPU count. null where the OS doesn't report it (Windows). */
  loadPerCpu: number | null;
  /** active + waiting crawl jobs — "is there more work than current slots?". */
  pendingWork: number;
}

export interface AdaptiveConfig {
  min: number;
  max: number;
  step: number;
  /** free-RAM ratio below which we shed a step (memory protection). */
  lowMemRatio: number;
  /** free-RAM ratio above which scaling up is permitted. */
  highMemRatio: number;
  /** load-per-CPU above which we never scale up (and shed a step). */
  highLoadPerCpu: number;
}

/**
 * Decide the next worker concurrency from the current value and a resource
 * sample. Pure — no I/O — so it is exhaustively unit-testable.
 */
export function nextConcurrency(current: number, s: ResourceSample, cfg: AdaptiveConfig): number {
  const clamp = (n: number) => Math.max(cfg.min, Math.min(cfg.max, n));
  // MEMORY PROTECTION / backpressure: low free RAM → shed load right away.
  if (s.freeMemRatio < cfg.lowMemRatio) return clamp(current - cfg.step);
  // CPU PROTECTION: sustained high load → shed a step, never add.
  if (s.loadPerCpu !== null && s.loadPerCpu > cfg.highLoadPerCpu) return clamp(current - cfg.step);
  // SCALE UP only when every current slot is busy with more work waiting, RAM has
  // comfortable headroom, and CPU (if known) isn't near the limit.
  const saturated = s.pendingWork > current;
  const cpuOk = s.loadPerCpu === null || s.loadPerCpu < cfg.highLoadPerCpu * 0.8;
  if (saturated && s.freeMemRatio > cfg.highMemRatio && cpuOk) return clamp(current + cfg.step);
  return clamp(current);
}

/** Snapshot current system resources (+ the supplied pending-work count). */
export function sampleResources(pendingWork: number): ResourceSample {
  const total = os.totalmem();
  const free = os.freemem();
  const load1 = os.loadavg()[0] ?? 0; // 0 on Windows (no load average)
  const cpus = os.cpus().length || 1;
  return { freeMemRatio: total > 0 ? free / total : 1, loadPerCpu: load1 > 0 ? load1 / cpus : null, pendingWork };
}

/** BullMQ Worker's runtime-settable concurrency (only the part we touch). */
export interface ConcurrencyControllable { concurrency: number }

/**
 * Start the adaptive controller. Every `intervalMs` it samples resources +
 * queued work and adjusts `worker.concurrency`. Returns a stop function.
 */
export function startAdaptiveConcurrency(
  worker: ConcurrencyControllable,
  cfg: AdaptiveConfig,
  sampleWork: () => Promise<number>,
  intervalMs = 30_000,
): () => void {
  let current = worker.concurrency;
  logger.info({ ...cfg }, `adaptive concurrency ON — start=${current}, range ${cfg.min}-${cfg.max} step ${cfg.step}`);
  const timer = setInterval(async () => {
    try {
      const pending = await sampleWork();
      const s = sampleResources(pending);
      const next = nextConcurrency(current, s, cfg);
      if (next !== current) {
        worker.concurrency = next;
        logger.info(
          { from: current, to: next, freeMemRatio: +s.freeMemRatio.toFixed(2), loadPerCpu: s.loadPerCpu, pending },
          `adaptive concurrency ${next > current ? "↑" : "↓"} ${current}→${next}`,
        );
        current = next;
      }
    } catch (e) {
      logger.warn({ err: String(e) }, "adaptive concurrency tick failed");
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
