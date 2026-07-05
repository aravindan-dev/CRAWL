/**
 * Enqueue a crawl job for every university directly onto BullMQ (no API needed).
 * The running crawler worker picks them up. Quick, exits when done.
 *
 * Run: tsx src/enqueue-all.ts
 */
import { env, contextsForTarget } from "@clg/shared";
import { prisma, jobRepository } from "@clg/database";
import { enqueueCrawl, closeRedisConnection } from "@clg/queue";

async function main() {
  // Only (re)enqueue universities that haven't completed — keep finished work.
  const unis = await prisma.university.findMany({
    where: { crawl_status: { not: "COMPLETED" } },
    orderBy: { name: "asc" },
  });
  // One crawl execution per context — "both" enqueues TWO isolated crawls.
  // CONTEXT-OUTER ordering (every university's ELIGIBILITY first, then every
  // SCHOLARSHIP): with CRAWL_CONCURRENCY > 1 the parallel workers pick
  // DIFFERENT universities — different domains, so per-site politeness budgets
  // don't stack and throughput scales ~linearly with worker count. The old
  // university-outer order handed two workers the SAME domain (both contexts
  // of one university at once), doubling bot-protection pressure on that site.
  const contexts = contextsForTarget(env.CRAWL_TARGET);
  let n = 0;
  for (const context of contexts) {
    for (const u of unis) {
      const job = await jobRepository.create({ university_id: u.id, job_type: "DISCOVER", crawl_context: context });
      await enqueueCrawl({ universityId: u.id, crawlJobId: job.id, context });
      n++;
    }
  }
  for (const u of unis) {
    await prisma.university.update({ where: { id: u.id }, data: { crawl_status: "QUEUED" } });
  }
  console.log(`ENQUEUED ${n} crawl jobs (${contexts.join(" + ")})`);
  await closeRedisConnection();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("ENQUEUE_ERROR", err);
  process.exit(1);
});
