/**
 * END-TO-END verification of STRICT CRAWL-CONTEXT ISOLATION.
 *
 * Spins up a local fake university site whose scholarship pages link to
 * eligibility / course pages (and vice versa), then runs the REAL crawl engine
 * (Playwright + Crawlee) twice — once per context — while recording every HTTP
 * request the site receives. Proves, at the network level:
 *
 *   1. A SCHOLARSHIP crawl never sends a single request to eligibility /
 *      admissions / course URLs (they are discovered, classified, and rejected
 *      BEFORE fetch — recorded as REJECTED_CROSS_CONTEXT with no http_status).
 *   2. An ELIGIBILITY crawl never requests scholarship/funding URLs.
 *   3. Only the validated individual course page produces a snapshot/parse job;
 *      its PRIMARY URL is the main course page, the entry-requirements anchor
 *      is secondary metadata (eligibility_url).
 *
 * Run: tsx src/verify-context-isolation.ts   (needs Postgres + Redis running)
 */
import http from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@clg/database";
import { CrawlContext, repoRoot } from "@clg/shared";
import { getParseQueue, closeRedisConnection } from "@clg/queue";
import { runUniversityCrawl } from "./crawl/runCrawl.js";

const PORT = 4599;
const BASE = `http://localhost:${PORT}`;

const link = (href: string, text: string) => `<li><a href="${href}">${text}</a></li>`;
const page = (title: string, body: string, links: string[] = []) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}<ul>${links.join("")}</ul></main></body></html>`;

// A dozen eligibility links on the scholarship listing — every one must be
// rejected pre-fetch in a scholarship crawl (scenario 9, scaled for runtime).
const ELIG_LINKS = Array.from({ length: 12 }, (_, i) => `/admissions/entry-requirements/section-${i + 1}`);

const ROUTES: Record<string, string> = {
  "/": page("Example Test University", "<p>Welcome to our university.</p>", [
    link("/study", "Study with us"),
    link("/scholarships", "Scholarships and funding"),
    link("/admissions/entry-requirements", "Entry requirements"),
    link("/courses", "Our courses"),
  ]),
  "/study": page("Study", "<p>Everything about studying here.</p>", [
    link("/courses", "Find a course"),
    link("/scholarships", "Scholarships"),
  ]),
  "/scholarships": page("Scholarships", "<p>Scholarship and funding opportunities for international students.</p>", [
    link("/scholarships/international-excellence-award", "International Excellence Scholarship"),
    link("/admissions/entry-requirements", "Check eligibility"),
    link("/courses/computer-science-bsc", "Find your course"),
    ...ELIG_LINKS.map((u, i) => link(u, `Eligibility criteria part ${i + 1}`)),
  ]),
  "/scholarships/international-excellence-award": page(
    "International Excellence Scholarship",
    `<p>A tuition fee waiver scholarship of £5,000 for outstanding international students.
     This scholarship is awarded on academic merit. How to apply for this scholarship:
     submit your application before the deadline.</p>`,
    [link("/admissions/entry-requirements", "Check eligibility"), link("/courses/computer-science-bsc", "View programme")],
  ),
  "/admissions/entry-requirements": page(
    "Entry requirements",
    `<p>General entry requirements for all applicants. International students need
     IELTS 6.5. Minimum grades vary by course. Selection criteria apply.</p>`,
    [link("/courses/computer-science-bsc", "Computer Science BSc")],
  ),
  ...Object.fromEntries(
    ELIG_LINKS.map((u, i) => [u, page(`Entry requirements ${i + 1}`, "<p>Eligibility criteria and entry requirements details.</p>")]),
  ),
  "/courses": page("Our courses", "<p>Browse all undergraduate courses and programmes.</p>", [
    link("/courses/computer-science-bsc", "Computer Science BSc (Hons)"),
    link("/scholarships", "Scholarships"),
  ]),
  "/courses/computer-science-bsc": page(
    "Computer Science BSc (Hons)",
    `<p>BSc (Hons) Computer Science. Duration: 3 years full-time. Start dates: September.</p>
     <p><a href="#entry-requirements">Entry requirements</a></p>
     <h2>Course overview</h2><p>What you'll study: modules include algorithms and databases.</p>
     <section id="entry-requirements"><h2>Entry requirements</h2>
       <p>AAB at A-level including Mathematics. International students: IELTS 6.5 overall.
       Minimum grades and required subjects are listed above. How to apply below.</p></section>`,
    [link("/scholarships/international-excellence-award", "Scholarships for this course")],
  ),
};

async function main() {
  const requested: string[] = [];
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!.replace(/\/$/, "") || "/";
    if (path !== "/robots.txt" && path !== "/favicon.ico" && !path.startsWith("/sitemap")) requested.push(path);
    const body = ROUTES[path];
    if (!body) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(page("Page not found", "<p>404 — page not found.</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(PORT, r));
  process.env.ENABLE_SITEMAP = "false"; // no sitemap probing against localhost

  const uni = await prisma.university.create({
    data: { name: "Context Isolation Test University", country: "Testland", base_url: BASE },
  });
  const failures: string[] = [];
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failures.push(label);
  };

  try {
    // ---------- 1) SCHOLARSHIP crawl ----------------------------------------
    console.log("\n=== SCHOLARSHIP crawl ===");
    const schJob = await prisma.crawlJob.create({ data: { university_id: uni.id, job_type: "DISCOVER", crawl_context: "SCHOLARSHIP" } });
    const schResult = await runUniversityCrawl(uni, schJob.id, CrawlContext.SCHOLARSHIP);
    const schRequested = [...requested];
    console.log(`fetched paths: ${JSON.stringify([...new Set(schRequested)].sort())}`);
    console.log(`stats: ${JSON.stringify(schResult)}`);

    const eligFetched = schRequested.filter((p) => p.startsWith("/admissions") || p.startsWith("/courses"));
    check(eligFetched.length === 0, `scholarship crawl made ZERO requests to eligibility/course URLs (got ${eligFetched.length})`);
    check(schRequested.some((p) => p === "/scholarships/international-excellence-award"), "scholarship crawl fetched the individual scholarship page");

    const rejected = await prisma.discoveredLink.findMany({
      where: { university_id: uni.id, crawl_context: "SCHOLARSHIP", status: "REJECTED_CROSS_CONTEXT" },
    });
    const rejectedUrls = new Set(rejected.map((r) => new URL(r.url).pathname));
    check(rejectedUrls.has("/admissions/entry-requirements"), "the 'Check eligibility' link was recorded as REJECTED_CROSS_CONTEXT");
    check(rejectedUrls.has("/courses/computer-science-bsc"), "the 'Find your course' link was recorded as REJECTED_CROSS_CONTEXT");
    check(
      ELIG_LINKS.every((u) => rejectedUrls.has(u)),
      `all ${ELIG_LINKS.length} eligibility links on the scholarship page were rejected before fetch`,
    );
    check(rejected.every((r) => r.http_status === null && !r.screenshot_path && !r.html_path && !r.text_path), "rejected links have no http_status and zero artifacts (never fetched)");

    const schSnapshots = await prisma.pageSnapshot.count({ where: { university_id: uni.id } });
    check(schSnapshots === 0, "scholarship crawl created ZERO page snapshots (no parse inputs)");

    const schValidated = await prisma.discoveredLink.findMany({ where: { university_id: uni.id, crawl_context: "SCHOLARSHIP", content_verified: true } });
    check(
      schValidated.length === 1 && new URL(schValidated[0]!.url).pathname === "/scholarships/international-excellence-award",
      "exactly the individual scholarship page was validated as a scholarship target",
    );

    // ---------- 2) ELIGIBILITY crawl ----------------------------------------
    console.log("\n=== ELIGIBILITY crawl ===");
    requested.length = 0;
    const eligJob = await prisma.crawlJob.create({ data: { university_id: uni.id, job_type: "DISCOVER", crawl_context: "ELIGIBILITY" } });
    const eligResult = await runUniversityCrawl(uni, eligJob.id, CrawlContext.ELIGIBILITY);
    const eligRequested = [...requested];
    console.log(`fetched paths: ${JSON.stringify([...new Set(eligRequested)].sort())}`);
    console.log(`stats: ${JSON.stringify(eligResult)}`);

    const schFetched = eligRequested.filter((p) => p.startsWith("/scholarships"));
    check(schFetched.length === 0, `eligibility crawl made ZERO requests to scholarship URLs (got ${schFetched.length})`);
    check(eligRequested.includes("/courses/computer-science-bsc"), "eligibility crawl fetched the individual course page");
    check(eligRequested.includes("/admissions/entry-requirements"), "eligibility crawl may use the general entry-requirements page for discovery");

    const courseLink = await prisma.discoveredLink.findFirst({
      where: { university_id: uni.id, crawl_context: "ELIGIBILITY", url: `${BASE}/courses/computer-science-bsc` },
    });
    check(!!courseLink && courseLink.content_verified, "the individual course page is a VALIDATED course target");
    check(!!courseLink && courseLink.page_class === "COURSE_PAGE", "the course page is classified COURSE_PAGE");
    check(
      !!courseLink && (courseLink.final_url ?? courseLink.url).includes("/courses/computer-science-bsc") && !(courseLink.final_url ?? "").includes("#"),
      "the PRIMARY course URL is the main course page (no anchor fragment)",
    );
    check(!!courseLink?.eligibility_url && courseLink.eligibility_url.includes("#entry-requirements"), "the entry-requirements anchor is stored as SECONDARY metadata (eligibility_url)");

    const generalElig = await prisma.discoveredLink.findFirst({
      where: { university_id: uni.id, crawl_context: "ELIGIBILITY", url: `${BASE}/admissions/entry-requirements` },
    });
    check(!!generalElig && !generalElig.content_verified, "the general entry-requirements page is DISCOVERY-ONLY (not a validated course target)");

    const eligSnapshots = await prisma.pageSnapshot.findMany({ where: { university_id: uni.id } });
    check(
      eligSnapshots.length === 1 && eligSnapshots[0]!.final_url.includes("/courses/computer-science-bsc") && eligSnapshots[0]!.crawl_context === "ELIGIBILITY",
      "exactly ONE snapshot/parse input exists — the validated course page (ELIGIBILITY context)",
    );

    // Clean up the parse job the eligibility crawl legitimately enqueued.
    const q = getParseQueue();
    for (const s of eligSnapshots) await (await q.getJob(`parse-${s.id}`))?.remove().catch(() => {});
  } finally {
    await prisma.university.delete({ where: { id: uni.id } }).catch(() => {});
    for (const dir of ["fingerprints", "facts"]) {
      rmSync(join(repoRoot(), "storage", "state", dir, `${uni.id}.json`), { force: true });
    }
    server.close();
    await closeRedisConnection().catch(() => {});
    await prisma.$disconnect();
  }

  console.log(failures.length ? `\nRESULT: FAIL (${failures.length} failed)` : "\nRESULT: ALL CHECKS PASSED");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("VERIFY_ERROR", e);
  process.exit(1);
});
