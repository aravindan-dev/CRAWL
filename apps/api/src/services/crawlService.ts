import { universityRepository, jobRepository } from "@clg/database";
import { enqueueCrawl, obliterateCrawlQueue } from "@clg/queue";
import { JobType, contextsForTarget } from "@clg/shared";
import { resetCrawlArtifacts, getCrawlSettings } from "./crawlAdminService.js";
import { getCrawlerState, startCrawler } from "./crawlerControlService.js";

/**
 * Create the CrawlJob row + enqueue the BullMQ crawl job for one university.
 * Every crawl EXECUTION has exactly one context (ELIGIBILITY xor SCHOLARSHIP)
 * — the "both" target runs TWO separate, fully-isolated executions, never one
 * mixed crawl. The context is stamped on the CrawlJob row AND the queue
 * payload so it survives the whole lifecycle.
 *
 * Contexts are CHAINED, not enqueued together: "both" only enqueues the FIRST
 * context (eligibility/courses — the primary deliverable) now; the worker
 * enqueues SCHOLARSHIP for this same university once eligibility finishes (see
 * crawlWorker.ts). Enqueueing both immediately let BullMQ pull them into two
 * concurrent worker slots, so one university's course crawl and scholarship
 * crawl hit the SAME host at the same time — doubling the effective request
 * rate against it (each side runs its own independent politeness/throttle)
 * with no throughput benefit, since different universities already crawl in
 * parallel via CRAWL_CONCURRENCY.
 */
export async function startCrawl(universityId: string) {
  const university = await universityRepository.findById(universityId);
  if (!university) throw new Error("University not found");
  if (!university.base_url) {
    // No website yet — can't crawl. Mark it so the UI nudges the user to add/find one.
    await universityRepository.updateCrawlStatus(universityId, "IDLE");
    throw new Error(`No website set for "${university.name}". Use "Find website" (or add a URL) first.`);
  }

  const allContexts = contextsForTarget(getCrawlSettings().CRAWL_TARGET);
  // RESUME AT THE RIGHT LINK IN THE CHAIN: a university whose eligibility
  // context already COMPLETED (crash/stall happened during scholarship, or
  // this is a plain resume) must continue with scholarship, not restart
  // eligibility from scratch. A fresh crawl (after resetCrawlArtifacts wipes
  // crawl_job rows) naturally has none completed, so this is a no-op then.
  const completed = allContexts.length > 1 ? await jobRepository.completedContexts(universityId) : new Set<string>();
  const pending = allContexts.filter((c) => !completed.has(c));
  const [context, ...rest] = pending.length ? pending : allContexts;
  await universityRepository.updateCrawlStatus(universityId, "QUEUED");
  const job = await jobRepository.create({ university_id: universityId, job_type: JobType.DISCOVER, crawl_context: context! });
  await enqueueCrawl({ universityId, crawlJobId: job.id, context, chainNextContexts: rest.length ? rest : undefined });
  return { crawlJobId: job.id, crawlJobIds: [job.id], contexts: [context, ...rest], universityId };
}

/**
 * Crawl every university FROM SCRATCH. Clears the queue, then wipes the previous
 * run's crawl artifacts (links/pages/jobs) and resets every university to IDLE
 * with zeroed counters — so the live stats (Links found, Pages crawled, Completed,
 * ETA) all start fresh and climb in real time for THIS crawl. To continue a
 * previous crawl instead of starting over, use Resume (`resumeCrawlAll`), which
 * keeps the data and skips already-crawled pages.
 */
export async function startCrawlAll() {
  await obliterateCrawlQueue(); // remove stuck/orphaned jobs → guaranteed clean start
  await resetCrawlArtifacts(); // FRESH crawl: clear the previous run so stats start at zero
  const { items } = await universityRepository.list({ take: 1000 });
  const started: string[] = [];
  let skippedNoUrl = 0;
  for (const u of items) {
    if (!u.base_url) { skippedNoUrl += 1; continue; } // no website yet — skip, don't fail the batch
    await startCrawl(u.id);
    started.push(u.id);
  }
  return { started: started.length, universityIds: started, skippedNoUrl };
}

/**
 * Clear the entire crawl queue (removes stuck/duplicate jobs) and reset any
 * in-progress universities back to IDLE. Use to recover from a stalled/duplicated
 * queue, then start fresh. Crawled data (links/snapshots) is kept, so a fresh
 * crawl resumes from where it left off.
 */
export async function drainCrawlQueue() {
  await obliterateCrawlQueue();
  const { items } = await universityRepository.list({ take: 1000 });
  let reset = 0;
  for (const u of items) {
    if (["DISCOVERING", "QUEUED", "STOPPED"].includes(u.crawl_status)) {
      await universityRepository.updateCrawlStatus(u.id, "IDLE");
      reset += 1;
    }
  }
  return { drained: true, reset };
}

/** Mark a university crawl as stopped (best-effort flag; in-flight pages finish). */
export async function stopCrawl(universityId: string) {
  await universityRepository.updateCrawlStatus(universityId, "STOPPED");
  return { universityId, status: "STOPPED" };
}

/**
 * Resume every incomplete university — re-queues each so the crawler continues
 * EXACTLY where it left off (runUniversityCrawl skips already-visited pages and
 * re-seeds the pending frontier). Use after stopping the engine / a crash.
 */
export async function resumeCrawlAll() {
  await obliterateCrawlQueue(); // clear any stuck/orphaned jobs first, then re-queue cleanly
  const { items } = await universityRepository.list({ take: 1000 });
  const resumed: string[] = [];
  let skippedNoUrl = 0;
  let skippedDone = 0;
  for (const u of items) {
    if (u.crawl_status === "COMPLETED") { skippedDone += 1; continue; }
    if (!u.base_url) { skippedNoUrl += 1; continue; }
    await startCrawl(u.id); // re-queue → the crawl resumes (already-done pages skipped)
    resumed.push(u.id);
  }
  return { resumed: resumed.length, skippedNoUrl, skippedDone };
}

/**
 * One-click RECOVERY for a stalled crawl. The common stall is: the engine OOM-
 * crashed mid-university, the watchdog relaunched the PROCESS, but the in-flight
 * BullMQ job was lost (exhausted its retries) — so the university sits in
 * DISCOVERING with nothing processing it. Restarting the process alone can't fix
 * that; RE-ENQUEUING does. So recover = (1) make sure the engine is running, then
 * (2) re-queue every incomplete university so each lost/failed job is recreated and
 * the crawl continues from where it left off (already-crawled pages are skipped).
 */
export async function recoverCrawl() {
  let engineStarted = false;
  if (!getCrawlerState().running) {
    startCrawler();
    engineStarted = true;
  }
  const r = await resumeCrawlAll();
  return { engineStarted, ...r };
}
