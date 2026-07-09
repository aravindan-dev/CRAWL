import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Let's find the Canberra university
  const canberra = await prisma.university.findFirst({
    where: {
      OR: [
        { name: { contains: "Canberra", mode: "insensitive" } },
        { base_url: { contains: "canberra", mode: "insensitive" } }
      ]
    }
  });

  if (!canberra) {
    console.log("❌ University of Canberra not found in the database!");
    return;
  }

  console.log("=== University Details ===");
  console.log(`ID: ${canberra.id}`);
  console.log(`Name: ${canberra.name}`);
  console.log(`Country: ${canberra.country}`);
  console.log(`Base URL: ${canberra.base_url}`);
  console.log(`Crawl Status: ${canberra.crawl_status}`);
  console.log(`Total Links Found: ${canberra.total_links_found}`);
  console.log(`Total Valid Links: ${canberra.total_valid_links}`);
  console.log(`Total Courses Extracted: ${canberra.total_courses_extracted}`);

  // Fetch Crawl Jobs for this university
  const jobs = await prisma.crawlJob.findMany({
    where: { university_id: canberra.id },
    orderBy: { created_at: "desc" },
    take: 5
  });

  console.log("\n=== Crawl Jobs (Latest 5) ===");
  console.table(jobs.map(j => ({
    id: j.id,
    type: j.job_type,
    context: j.crawl_context,
    status: j.status,
    started: j.started_at,
    finished: j.finished_at,
    created: j.created_at
  })));

  // Fetch Discovered Links counts by status
  const linkStats = await prisma.discoveredLink.groupBy({
    by: ['status'],
    where: { university_id: canberra.id },
    _count: { id: true }
  });

  console.log("\n=== Discovered Links Stats ===");
  console.table(linkStats.map(s => ({
    status: s.status,
    count: s._count.id
  })));

  // Fetch the latest 10 crawl logs with WARN or ERROR
  const logs = await prisma.crawlLog.findMany({
    where: { university_id: canberra.id, status: { in: ["WARN", "ERROR"] } },
    orderBy: { created_at: "desc" },
    take: 10
  });

  console.log("\n=== Crawl Logs (WARN/ERROR, Latest 10) ===");
  logs.forEach(l => {
    console.log(`[${l.created_at.toISOString()}] [${l.status}] Action: ${l.action}`);
    console.log(`  Message: ${l.message}`);
    if (l.error_stack) {
      console.log(`  Stack: ${l.error_stack.substring(0, 500)}...`);
    }
  });

  // Also query general links that failed
  const failedLinks = await prisma.discoveredLink.findMany({
    where: { university_id: canberra.id, status: "BROKEN_LINK" },
    orderBy: { updated_at: "desc" },
    take: 5
  });

  if (failedLinks.length > 0) {
    console.log("\n=== Failed Links (Latest 5) ===");
    failedLinks.forEach(fl => {
      console.log(`URL: ${fl.url}`);
      console.log(`  HTTP: ${fl.http_status} | Error: ${fl.error_message}`);
    });
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
