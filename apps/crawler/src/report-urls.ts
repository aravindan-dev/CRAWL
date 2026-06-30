/**
 * Generate the eligibility/criteria URL report from discovered links, grouped by
 * university (university-level eligibility URLs first, then course-level URLs).
 *
 * Precision: we filter by URL-path signals (admission/requirements/course paths)
 * rather than the content classifier, which over-tags any page mentioning
 * "degree/programme" in its nav. Reads the DB directly — works regardless of
 * API/crawler liveness. Re-run any time to snapshot progress.
 *
 * Writes storage/exports/eligibility-urls.{md,csv}.
 * Run: tsx src/report-urls.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@clg/database";
import { repoRoot } from "@clg/shared";

// General admission / entry-requirements pages (university-level eligibility).
const ELIG_URL =
  /(admission|entry[-_]?requirement|requirements?|eligib|how[-_]?to[-_]?apply|application|qualif|ucas|prerequisite|entry[-_]?criteria|tariff|\/apply(\/|$)|\/entry(\/|$))/i;

// Course / programme pages (course-level eligibility lives on these).
const COURSE_URL =
  /(\/courses?\/|\/programmes?\/|\/programs?\/|\/degrees?\/|\/undergraduate\/[^/]+|\/study\/[^/]+|bachelor|-bsc\b|-bs\b|-ba\b|-beng\b|-bba\b|-llb\b|-msc\b|-ma\b)/i;

// Clearly-irrelevant paths to exclude even if they slip past the positive filter.
const DENY_URL =
  /(imprint|about[-_]?us|newsroom|press|\/research|campus[-_]?map|data[-_]?protection|accessibility|gender[-_]?equality|\/history|\/contact|privacy|sitemap|\/login|\/people\/|\/staff|\/profile\/|\/news\/|\/events?\/|cookie)/i;

const SKIP_STATUS = new Set(["BROKEN_LINK", "BLOCKED", "DUPLICATE"]);

function urlOf(l: { final_url: string | null; url: string }): string {
  return (l.final_url ?? l.url).trim();
}

async function main() {
  const unis = await prisma.university.findMany({ orderBy: { name: "asc" } });

  const csv: string[] = ["university,country,level,score,status,url"];
  let md = "";
  let totalUni = 0;
  let totalCourse = 0;
  let universitiesWithUrls = 0;

  for (const u of unis) {
    const links = await prisma.discoveredLink.findMany({
      where: { university_id: u.id },
      orderBy: [{ link_score: "desc" }, { url: "asc" }],
    });

    const seen = new Set<string>();
    const uniLinks: typeof links = [];
    const courseLinks: typeof links = [];

    for (const l of links) {
      if (SKIP_STATUS.has(l.status)) continue;
      const url = urlOf(l);
      const low = url.toLowerCase();
      if (DENY_URL.test(low)) continue;
      if (seen.has(low)) continue;

      const isCourse = COURSE_URL.test(low);
      const isElig = ELIG_URL.test(low);
      if (isCourse) {
        seen.add(low);
        courseLinks.push(l);
      } else if (isElig) {
        seen.add(low);
        uniLinks.push(l);
      }
    }

    if (uniLinks.length + courseLinks.length > 0) universitiesWithUrls++;

    md += `## ${u.name}  \n`;
    md += `_${u.country} · ${u.base_url} · status=${u.crawl_status}_\n\n`;

    md += `**University eligibility / admission URLs (${uniLinks.length}):**\n`;
    if (uniLinks.length === 0) md += `- _(none yet)_\n`;
    for (const l of uniLinks) {
      const url = urlOf(l);
      md += `- ${url}\n`;
      csv.push(`"${u.name}","${u.country}","university",${l.link_score},"${l.status}","${url}"`);
      totalUni++;
    }

    md += `\n**Course eligibility URLs (${courseLinks.length}):**\n`;
    if (courseLinks.length === 0) md += `- _(none yet)_\n`;
    for (const l of courseLinks) {
      const url = urlOf(l);
      md += `- ${url}\n`;
      csv.push(`"${u.name}","${u.country}","course",${l.link_score},"${l.status}","${url}"`);
      totalCourse++;
    }
    md += `\n---\n\n`;
  }

  const header =
    `# Eligibility / Criteria URLs — ${unis.length} universities\n\n` +
    `- University-level eligibility/admission URLs: **${totalUni}**\n` +
    `- Course-level eligibility URLs: **${totalCourse}**\n` +
    `- Combined total: **${totalUni + totalCourse}**\n` +
    `- Universities with at least one URL: ${universitiesWithUrls}/${unis.length}\n` +
    `- Generated: ${new Date().toISOString()}\n\n---\n\n`;

  const dir = join(repoRoot(), "storage", "exports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "eligibility-urls.md"), header + md, "utf8");
  writeFileSync(join(dir, "eligibility-urls.csv"), csv.join("\n"), "utf8");

  console.log(
    `REPORT universities=${unis.length} with_urls=${universitiesWithUrls} university_urls=${totalUni} course_urls=${totalCourse} total=${totalUni + totalCourse}`,
  );
  console.log(`WROTE ${join(dir, "eligibility-urls.md")}`);
  console.log(`WROTE ${join(dir, "eligibility-urls.csv")}`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("REPORT_ERROR", err);
  process.exit(1);
});
