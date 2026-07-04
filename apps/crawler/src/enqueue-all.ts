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
  const contexts = contextsForTarget(env.CRAWL_TARGET);
  let n = 0;
  for (const u of unis) {
    for (const context of contexts) {
      const job = await jobRepository.create({ university_id: u.id, job_type: "DISCOVER", crawl_context: context });
      await enqueueCrawl({ universityId: u.id, crawlJobId: job.id, context });
      n++;
    }
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
