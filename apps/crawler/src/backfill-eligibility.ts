/**
 * Backfill the entry-requirements DEEP-LINK (eligibility_url) onto links that were
 * crawled BEFORE the live-deep-linking change — so the validated feed + export show
 * the exact eligibility URL without re-crawling. Uses the raw HTML already saved for
 * each parseable page (offline, no network), computing the same anchor the live
 * crawl now computes. A page that has an entry-requirements section is also marked
 * content_verified (it carries entry-requirement content even when the requirements
 * load in a modal), which surfaces every such course in the live feed.
 *
 * Run: tsx src/backfill-eligibility.ts
 */
import { prisma } from "@clg/database";
import { LocalStorageProvider } from "@clg/shared";
import { entryRequirementAnchor, deepLinkEligibility } from "./extraction/eligibilityAnchor.js";

const storage = new LocalStorageProvider();
const COURSE_URL = /\/(courses?|programmes?|programs?|degrees?)\/[a-z0-9]/i;

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

async function main() {
  const links = await prisma.discoveredLink.findMany({
    where: { html_path: { not: null } },
    select: { id: true, url: true, final_url: true, html_path: true, content_verified: true, eligibility_url: true },
  });
  console.log(`[backfill] ${links.length} crawled pages with saved HTML — detecting entry-requirements anchors…`);

  let withAnchor = 0;
  let newlyVerified = 0;
  let done = 0;
  await pool(links, 8, async (l) => {
    let html = "";
    try {
      html = await storage.readText(l.html_path!);
    } catch {
      return; // saved HTML was cleaned up — re-crawl to repopulate
    }
    const target = (l.final_url ?? l.url).trim();
    const anchor = entryRequirementAnchor(html);
    const eligibilityUrl = anchor ? deepLinkEligibility(target, html) : null;

    const data: { eligibility_url?: string | null; content_verified?: boolean; evidence?: string } = {};
    if (eligibilityUrl && eligibilityUrl !== l.eligibility_url) data.eligibility_url = eligibilityUrl;
    // An entry-requirements section proves entry-requirement content even when it
    // lives in a modal — count it validated so the course shows in the live feed.
    if (anchor && !l.content_verified && COURSE_URL.test(target.toLowerCase())) {
      data.content_verified = true;
      data.evidence = `entry-requirements section (#${anchor})`;
      newlyVerified += 1;
    }
    if (Object.keys(data).length) {
      await prisma.discoveredLink.update({ where: { id: l.id }, data });
      if (eligibilityUrl) withAnchor += 1;
    }
    if (++done % 100 === 0) console.log(`[backfill] ${done}/${links.length}`);
  });

  console.log(`[backfill] deep-linked ${withAnchor} pages to their entry-requirements section; ${newlyVerified} newly validated (modal-only courses).`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("BACKFILL_ERROR", e);
  process.exit(1);
});
