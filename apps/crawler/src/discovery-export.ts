/**
 * DISCOVERY-CANDIDATE EXPORT — the "you still get the URLs" report.
 *
 * The validated exports (recheck.ts / report-urls.ts) only emit pages the engine
 * FETCHED and confirmed — so a Cloudflare-blocked university (every page 403s)
 * exports nothing, even though discovery already enumerated its whole sitemap.
 * This report emits every DISCOVERED candidate URL — course, eligibility/entry-
 * requirements, and scholarship — straight from the stored pre-fetch
 * classification (`page_class`) and score, WITHOUT needing to open the page.
 * Each row is tagged CONFIRMED (content_verified — the engine fetched + validated
 * it) or CANDIDATE (discovered only — awaiting access), so nothing is lost and
 * nothing is over-claimed.
 *
 * This is the discovery half of the hybrid model: maximum URL recall now, with
 * validation filled in as pages become fetchable. Reads the DB directly — works
 * regardless of API/crawler liveness, and INCLUDES blocked/queued/deferred rows.
 *
 * Writes storage/exports/discovery-candidates.{md,csv}.
 * Run: tsx src/discovery-export.ts [--university <name-substring>]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@clg/database";
import { repoRoot, getKeywords, keywordsToRegex, PageClass } from "@clg/shared";

const INTL_RE = keywordsToRegex(getKeywords().international);

// page_class → which candidate bucket a discovered URL belongs to. Course pages
// also carry course-level eligibility, so they appear under BOTH course and the
// eligibility view via the course column (kept separate here for clarity).
const COURSE_CLASSES = new Set<string>([PageClass.COURSE_PAGE, PageClass.COURSE_LISTING]);
const ELIG_CLASSES = new Set<string>([PageClass.ELIGIBILITY_PAGE, PageClass.ADMISSIONS_PAGE, PageClass.INTERNATIONAL_ADMISSIONS_PAGE]);
const SCH_CLASSES = new Set<string>([PageClass.SCHOLARSHIP_PAGE, PageClass.SCHOLARSHIP_LISTING, PageClass.FUNDING_PAGE]);

type Bucket = "course" | "eligibility" | "scholarship";
const bucketOf = (pageClass: string | null): Bucket | null => {
  if (!pageClass) return null;
  if (COURSE_CLASSES.has(pageClass)) return "course";
  if (ELIG_CLASSES.has(pageClass)) return "eligibility";
  if (SCH_CLASSES.has(pageClass)) return "scholarship";
  return null;
};

const urlOf = (l: { final_url: string | null; url: string }) => (l.final_url ?? l.url).trim();

async function main(): Promise<void> {
  const nameFilter = (() => { const i = process.argv.indexOf("--university"); return i >= 0 ? process.argv[i + 1] : undefined; })();
  const unis = await prisma.university.findMany({
    where: nameFilter ? { name: { contains: nameFilter, mode: "insensitive" } } : undefined,
    orderBy: { name: "asc" },
  });

  // Confidence: CONFIRMED pages were fetched + validated (95). CANDIDATE pages are
  // discovered-only, banded 70-85 by their pre-fetch link score (stronger course/
  // eligibility/scholarship signals → higher) — per the hybrid model's candidate
  // band, to be upgraded to CONFIRMED once the page becomes fetchable.
  const confidenceOf = (confirmed: boolean, linkScore: number) =>
    confirmed ? 95 : Math.min(85, 70 + Math.floor(Math.max(0, linkScore) / 12));

  const csv: string[] = ["university,country,bucket,confidence_state,confidence,international,link_score,status,url"];
  let md = `# Discovery-candidate URLs — ${unis.length} universit${unis.length === 1 ? "y" : "ies"}\n\n`;
  md += `_Every discovered course / eligibility / scholarship URL, including pages that could not yet be fetched (Cloudflare/403). CONFIRMED = fetched + validated; CANDIDATE = discovered only, awaiting access._\n\n`;
  const totals = { course: 0, eligibility: 0, scholarship: 0, confirmed: 0, candidate: 0 };

  for (const u of unis) {
    // ALL discovered rows — including BLOCKED / QUEUED / PDF_DEFERRED. We keep
    // everything with a usable candidate class; only truly irrelevant/dead rows
    // and duplicates are dropped. Cross-context rejects are the OTHER context's
    // targets and are re-bucketed here by their own page_class so scholarship
    // URLs found during an eligibility crawl still surface.
    const links = await prisma.discoveredLink.findMany({
      where: { university_id: u.id, status: { notIn: ["DUPLICATE", "BROKEN_LINK", "NOT_RELEVANT"] } },
      orderBy: [{ content_verified: "desc" }, { link_score: "desc" }, { url: "asc" }],
      select: { url: true, final_url: true, canonical_url: true, page_class: true, link_score: true, status: true, content_verified: true, evidence: true, eligibility_url: true },
    });

    const seen = new Set<string>();
    const buckets: Record<Bucket, typeof links> = { course: [], eligibility: [], scholarship: [] };
    for (const l of links) {
      const b = bucketOf(l.page_class);
      if (!b) continue;
      const key = (l.canonical_url ?? urlOf(l)).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      buckets[b].push(l);
    }

    const nConfirmed = links.filter((l) => l.content_verified).length;
    md += `## ${u.name}\n_${u.country} · ${u.base_url} · crawl=${u.crawl_status}_\n`;
    md += `course=${buckets.course.length} · eligibility=${buckets.eligibility.length} · scholarship=${buckets.scholarship.length} · confirmed=${nConfirmed}\n\n`;

    for (const b of ["course", "eligibility", "scholarship"] as Bucket[]) {
      const rows = buckets[b];
      md += `**${b} URLs (${rows.length}):**\n`;
      if (!rows.length) md += `- _(none discovered yet)_\n`;
      for (const l of rows) {
        const url = urlOf(l);
        // Prefer the computed entry-requirements deep link when we have one.
        const outUrl = b === "eligibility" || b === "course" ? l.eligibility_url ?? url : url;
        const state = l.content_verified ? "CONFIRMED" : "CANDIDATE";
        const conf = confidenceOf(l.content_verified, l.link_score);
        const intl = INTL_RE.test(url.toLowerCase()) ? "intl" : "";
        md += `- [${state} ${conf}%] ${outUrl}${l.evidence ? ` — ${l.evidence.slice(0, 80)}` : ""}\n`;
        csv.push(`"${u.name}","${u.country}","${b}","${state}",${conf},"${intl}",${l.link_score},"${l.status}","${outUrl}"`);
        totals[b]++;
        if (l.content_verified) totals.confirmed++; else totals.candidate++;
      }
      md += `\n`;
    }
    md += `---\n\n`;
  }

  const summary =
    `_Totals: course=${totals.course}, eligibility=${totals.eligibility}, scholarship=${totals.scholarship} · ` +
    `CONFIRMED=${totals.confirmed}, CANDIDATE=${totals.candidate}_\n\n`;
  const dir = join(repoRoot(), "storage", "exports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "discovery-candidates.md"), summary + md, "utf8");
  writeFileSync(join(dir, "discovery-candidates.csv"), csv.join("\n"), "utf8");
  console.log(summary.replace(/_/g, "").trim());
  console.log(`\nsaved → storage/exports/discovery-candidates.{md,csv} (${csv.length - 1} rows)`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
