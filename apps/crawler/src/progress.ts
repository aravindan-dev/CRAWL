/**
 * Clear, one-by-one pipeline view. For every university it shows the automated
 * stages and their live counts so the process is easy to follow:
 *
 *   Crawl → Discover links → Validate/classify → Snapshot + Chunk → Parse criteria
 *
 * Run: tsx src/progress.ts
 */
import { prisma, LinkStatus } from "@clg/database";

const VALID: LinkStatus[] = [
  LinkStatus.VALID_COURSE_PAGE,
  LinkStatus.VALID_ADMISSION_PAGE,
  LinkStatus.POSSIBLE_REQUIREMENT_PAGE,
];

function icon(status: string): string {
  if (status === "COMPLETED") return "[done]";
  if (status === "DISCOVERING") return "[CRAWLING]";
  if (status === "QUEUED") return "[queued]";
  if (status === "FAILED") return "[failed]";
  return "[idle]";
}

async function main() {
  const unis = await prisma.university.findMany({ orderBy: { name: "asc" } });
  console.log("Pipeline per university:  Crawl -> Links -> Validate -> Snapshot+Chunk -> Criteria URL\n");

  let done = 0;
  let totLinks = 0;
  let totValid = 0;
  let totSnap = 0;
  let totCrit = 0;

  let i = 0;
  for (const u of unis) {
    i++;
    const [links, valid, snapshots, criteria] = await Promise.all([
      prisma.discoveredLink.count({ where: { university_id: u.id } }),
      prisma.discoveredLink.count({ where: { university_id: u.id, status: { in: VALID } } }),
      prisma.pageSnapshot.count({ where: { university_id: u.id } }),
      prisma.courseCriteria.count({ where: { university_id: u.id } }),
    ]);
    if (u.crawl_status === "COMPLETED") done++;
    totLinks += links;
    totValid += valid;
    totSnap += snapshots;
    totCrit += criteria;

    console.log(`${icon(u.crawl_status).padEnd(11)} ${String(i).padStart(2)}/${unis.length}  ${u.name}`);
    console.log(
      `             links discovered=${links}  valid pages=${valid}  snapshots(chunked)=${snapshots}  criteria parsed=${criteria}`,
    );
  }

  console.log(`\nTOTALS  universities done=${done}/${unis.length}`);
  console.log(
    `        links=${totLinks}  valid eligibility pages=${totValid}  snapshots+chunked=${totSnap}  criteria records=${totCrit}`,
  );
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("PROGRESS_ERROR", err);
  process.exit(1);
});
