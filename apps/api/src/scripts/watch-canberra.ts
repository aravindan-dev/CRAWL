import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  for (let i = 0; i < 20; i++) {
    const canberra = await prisma.university.findFirst({
      where: { name: { contains: "Canberra", mode: "insensitive" } },
      select: {
        crawl_status: true,
        total_links_found: true,
        total_valid_links: true,
        total_courses_extracted: true,
      }
    });

    const linkStats = await prisma.discoveredLink.groupBy({
      by: ['status'],
      where: {
        university: { name: { contains: "Canberra", mode: "insensitive" } }
      },
      _count: { id: true }
    });

    const jobs = await prisma.crawlJob.findMany({
      where: {
        university: { name: { contains: "Canberra", mode: "insensitive" } },
        status: { in: ["RUNNING", "QUEUED"] }
      },
      select: { crawl_context: true, status: true, started_at: true }
    });

    const now = new Date().toISOString().substring(11, 19);
    const statsMap = Object.fromEntries(linkStats.map(s => [s.status, s._count.id]));

    console.log(`[${now}] Status: ${canberra?.crawl_status} | Links Found: ${canberra?.total_links_found} | Valid: ${canberra?.total_valid_links} | Active Jobs: ${jobs.length}`);
    console.log(`         QUEUED: ${statsMap['QUEUED'] ?? 0} | VALID_COURSE: ${statsMap['VALID_COURSE_PAGE'] ?? 0} | VALID_ADMISSION: ${statsMap['VALID_ADMISSION_PAGE'] ?? 0} | CROSS_CONTEXT: ${statsMap['REJECTED_CROSS_CONTEXT'] ?? 0}`);

    if (canberra?.crawl_status === "COMPLETED" || canberra?.crawl_status === "FAILED") {
      console.log(`\n✅ Crawl finished with status: ${canberra.crawl_status}`);
      break;
    }

    await new Promise(r => setTimeout(r, 10000)); // wait 10s
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
