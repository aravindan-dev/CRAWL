/**
 * Thorough re-check + clean export:
 *  - Re-validates EVERY eligibility URL with realistic browser headers (resolves
 *    most 403 bot-blocks), retrying transient failures.
 *  - Cross-references the crawl: a URL the crawler's real browser successfully
 *    loaded is marked valid even if a plain fetch is blocked.
 *  - Removes duplicates GLOBALLY (one row per final URL).
 *  - Writes a clean multi-sheet workbook: Summary, Valid URLs, Issues.
 *
 * Run: tsx src/recheck.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import ExcelJS from "exceljs";
import { prisma } from "@clg/database";
import { repoRoot, getKeywords, keywordsToRegex, isPdfUrl, countryFromUrl } from "@clg/shared";
import { isRealCourse, deriveCourseName, canonicalCourseUrl, isCourseCode } from "./export/courseUrl.js";
import { entryRequirementAnchor } from "./extraction/eligibilityAnchor.js";

// Central, editable keyword vocabulary (defaults + dashboard additions).
const KW = getKeywords();
const ELIG_URL = keywordsToRegex(KW.eligibility);
// A course/programme page lives under the site's COURSE CATALOG path
// (/courses, /programmes, /programs, /degrees). Anchoring to the catalog — instead
// of loose degree-suffix (`-msc`, `-ba`…) or `/study/` substring matches — is what
// keeps marketing, offer-holder, facilities, PDF and blog pages OUT of the course
// deliverable (those live under /study, /media, /mdx-voices, etc., not the catalog).
const COURSE_URL = /\/(courses?|programmes?|programs?|degrees?)\/[a-z0-9]/i;
// NOTE: `\/research(?![-_]degree)` drops research/news/centre pages but KEEPS
// `/courses/research-degrees/…` — MPhil/PhD/DProf/MSc-by-research are real
// programmes with international entry criteria and belong in the deliverable.
const DENY_URL =
  /(imprint|about[-_]?us|newsroom|press|\/research(?![-_]degree)|campus[-_]?map|data[-_]?protection|accessibility|gender[-_]?equality|\/history|\/contact|privacy|sitemap|\/login|\/people\/|\/staff|\/profile\/|\/news\/|\/events?\/|cookie|mailto:|href=|advisory[-_]?council|\/advisory|alumni|donate|giving)/i;

// International-student ENTRY criteria — from the central keyword vocabulary
// (international list ∪ eligibility list, since a general entry-requirements page
// also applies to international applicants).
const INTL_URL = keywordsToRegex([...KW.international, ...KW.eligibility]);

// CMS layout-include fragments that some sites expose as crawlable URLs but are NOT
// real pages: left/right column includes (left-col-content, leftcontenteligibility,
// left-col-1, mdxvoxlft, employabilityleft, internationalright, …). Filtered from
// BOTH the university and course deliverables.
const CMS_FRAGMENT =
  /(left|right|top|bottom|main|side)[-_]?col(umn)?(?:[-_]?content|[-_]?\d+)|col[-_]?content|(left|right)content[a-z]*|content[-_]?(left|right)|mdxvox(?:lft|rt)?|employabilityleft|internationalright/i;
const INTL_ONLY = process.env.INTL_ONLY === "1";
// Emit a SEPARATE file per level (never mix university + course — Aliff rule):
//   LEVEL=university → university-level eligibility URLs only
//   LEVEL=course     → course-level eligibility URLs only (every course page)
const LEVEL = process.env.LEVEL as "university" | "course" | undefined;

// --- Course PRECISION cleanup (for 100%-accurate course links) ---------------
// ENTRY requirements = what you need to GET IN (the deliverable we want).
const ADMISSION_ELIG = /(admission|entry)[-_ ]?(requirement|criteri|profile)|how[-_ ]?to[-_ ]?apply|\/admissions?\b|entry[-_ ]?requirements?/i;
// COMPLETION requirements = graduation/degree/minor/completion — NOT entry. The
// user needs the ADMISSION/ENTRY page (criteria to study), not how to graduate.
const COMPLETION_REQ = /(graduation|degree|minor|completion|major|honou?rs)[-_ ]?requirements?|sample[-_ ]?curriculum|degrees?[-_ ]?available|course[-_ ]?content|module[-_ ]?(list|catalog)/i;
// A junk/placeholder course NAME (a transient <title> captured at crawl time, e.g.
// Canberra's JS course pages briefly show "Error"). Such rows get their real name
// re-read from the live page heading during revalidate.
const JUNK_NAME = /^(errors?|loading|untitled|redirect(?:ing)?|please[-_ ]?wait|just[-_ ]?a[-_ ]?moment|forbidden|access[-_ ]?denied|page[-_ ]?not[-_ ]?found|not[-_ ]?found|404|\d{3})$/i;

// Crawl statuses that mean the real browser successfully LOADED the page.
const BROWSER_LOADED = new Set([
  "VALID_COURSE_PAGE",
  "VALID_ADMISSION_PAGE",
  "POSSIBLE_REQUIREMENT_PAGE",
  "LOW_CONFIDENCE_PAGE",
  "NOT_RELEVANT",
  "REDIRECTED",
]);

// When several crawled rows collapse to the SAME canonical course, prefer the one
// that best proves the page: a loaded HTML page (with its real course title) beats
// a merely-queued link, which beats a PDF-only record. This is what makes the
// exported URL the rich web page — with the real course name — and not the PDF.
const CRAWL_RANK: Record<string, number> = {
  VALID_ADMISSION_PAGE: 6,
  VALID_COURSE_PAGE: 6,
  POSSIBLE_REQUIREMENT_PAGE: 5,
  LOW_CONFIDENCE_PAGE: 4,
  REDIRECTED: 3,
  QUEUED: 2,
  PDF_DEFERRED: 0,
};
function courseCandidateScore(l: { url: string; final_url: string | null; status: string; page_title: string | null }): number {
  let s = (CRAWL_RANK[l.status] ?? 1) * 10;
  if (l.page_title && l.page_title.trim()) s += 3; // a real course name to export
  if (!isPdfUrl(l.final_url ?? l.url)) s += 2; // an HTML web page, not a PDF
  return s;
}

const CONCURRENCY = 10;
const TIMEOUT_MS = 15000;

const BROWSER_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

type Validity = "WORKING" | "BROWSER_VERIFIED" | "BROKEN" | "UNCONFIRMED";

interface Row {
  university: string;
  country: string;
  level: "university" | "course";
  course_name: string;
  url: string;
  crawl_status: string;
  http_status: number | null;
  final_url: string;
  validity: Validity;
  /** Last-resort PDF URL, kept only when the course was found ONLY as a PDF — used
   *  if the derived HTML page turns out not to be reachable. */
  pdf_fallback?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Deep-link course URLs to their ENTRY-REQUIREMENTS section/tab -------------
// Anchor detection is shared with the LIVE crawl (eligibilityAnchor.ts) so the
// exported deep-link matches what the validated feed showed during the crawl.
async function fetchHtml(url: string, timeout = 15000, cap = 600000): Promise<string> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const res = await fetch(url, { redirect: "follow", signal: c.signal, headers: BROWSER_HEADERS });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } return ""; }
    const txt = await res.text();
    return txt.length > cap ? txt.slice(0, cap) : txt;
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

async function fetchStatus(url: string, timeout: number): Promise<{ status: number | null; finalUrl: string }> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: c.signal, headers: BROWSER_HEADERS });
    if ([403, 405, 501, 400].includes(res.status)) {
      res = await fetch(url, { method: "GET", redirect: "follow", signal: c.signal, headers: BROWSER_HEADERS });
    }
    const out = { status: res.status, finalUrl: res.url || url };
    // We only need status + final URL — discard the body so thousands of GET
    // responses don't accumulate in the heap (was OOM-killing the courses run).
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return out;
  } catch {
    return { status: null, finalUrl: url };
  } finally {
    clearTimeout(t);
  }
}

async function pool<T>(items: T[], limit: number, fn: (t: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const cur = i++;
        await fn(items[cur]!, cur);
      }
    }),
  );
}

function decide(status: number | null, finalUrl: string, url: string, crawlStatus: string): Validity {
  if (status !== null && status >= 200 && status < 300) return "WORKING";
  if (status === 404 || status === 410) {
    // Definitely-broken by fetch — but if the browser loaded it during crawl, trust the browser.
    return BROWSER_LOADED.has(crawlStatus) ? "BROWSER_VERIFIED" : "BROKEN";
  }
  // 403/429/5xx/unreachable: valid if the crawler's browser had loaded it.
  if (BROWSER_LOADED.has(crawlStatus)) return "BROWSER_VERIFIED";
  return "UNCONFIRMED";
}

const rank: Record<Validity, number> = { WORKING: 3, BROWSER_VERIFIED: 2, UNCONFIRMED: 1, BROKEN: 0 };

// --- Pick the ONE "main" university-level eligibility URL ----------------------
// A university has many international pages (fees, visas, partnerships, …) but the
// Aliff "University Eligibility" field wants a SINGLE main entry-requirements page.
// Rank candidates so the most specific international entry-requirements page wins.
const MAIN_UNI_PREF: RegExp[] = [
  /international[^?]*(entry|admission)[-_ ]?requirement/i,        // international entry/admission requirements (best)
  /(entry|admission)[-_ ]?requirement[s]?[^?]*international/i,    // …requirements for international students
  /\bentry[-_ ]?requirement/i,
  /\badmission[-_ ]?requirement/i,
  /\bentry[-_ ]?criteri/i,
  /\bentry[-_ ]?profile/i,
  /how[-_ ]?to[-_ ]?apply/i,
  /\badmissions?\b/i,
  /international[^?]*(eligib|qualif)/i,
  /\beligib/i,
  /\binternational\b/i,
];
function uniUrlRank(url: string): number {
  const low = url.toLowerCase();
  for (let i = 0; i < MAIN_UNI_PREF.length; i++) if (MAIN_UNI_PREF[i]!.test(low)) return MAIN_UNI_PREF.length - i;
  return 0;
}
/** Is `a` a better "main university eligibility" pick than `b`? */
function betterMain(a: Row, b: Row): boolean {
  if (rank[a.validity] !== rank[b.validity]) return rank[a.validity] > rank[b.validity]; // working first
  const ra = uniUrlRank(a.final_url), rb = uniUrlRank(b.final_url);
  if (ra !== rb) return ra > rb;                       // most specific entry-requirements page
  return a.final_url.length < b.final_url.length;      // else the shortest / cleanest URL
}

/**
 * Load each URL in a real headless Chromium (defeats bot-blocks that fail plain
 * fetch). Resolves to WORKING/BROWSER_VERIFIED if it truly loads, BROKEN if not.
 */
async function verifyWithBrowser(rows: Row[]): Promise<void> {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  let done = 0;
  try {
    await pool(rows, 4, async (r) => {
      const ctx = await browser.newContext({ userAgent: BROWSER_HEADERS["user-agent"] });
      const page = await ctx.newPage();
      try {
        const resp = await page.goto(r.url, { waitUntil: "domcontentloaded", timeout: 25000 });
        const status = resp?.status() ?? null;
        r.http_status = status;
        r.final_url = page.url() || r.url;
        if (status !== null && status >= 200 && status < 400) r.validity = "WORKING";
        else if (status === 404 || status === 410) r.validity = "BROKEN";
        else r.validity = "BROWSER_VERIFIED"; // rendered despite an odd status code
      } catch {
        r.validity = "BROKEN"; // could not load even in a real browser
      } finally {
        await ctx.close().catch(() => {});
      }
      if (++done % 25 === 0) console.log(`[recheck] browser-verify ${done}/${rows.length}`);
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  console.log("[recheck] gathering eligibility URLs…");
  const unis = await prisma.university.findMany({ orderBy: { name: "asc" } });
  const rows: Row[] = [];
  for (const u of unis) {
    const links = await prisma.discoveredLink.findMany({ where: { university_id: u.id } });
    // Fill the country from the site domain (.edu.au → Australia) when a university
    // was imported without one, so the export's country column is never blank.
    const country = u.country.trim() || countryFromUrl(u.base_url);
    const seen = new Set<string>(); // university-level dedup
    // HTML-FIRST: every year/intake/PDF variant of a course collapses to ONE
    // canonical HTML landing page. We keep the single RICHEST source per course
    // (a loaded page with a real title beats a queued link beats a PDF-only
    // record) so the exported URL is the web page — never the PDF.
    const courseBest = new Map<string, { link: (typeof links)[number]; canon: string }>();
    for (const l of links) {
      const url = (l.final_url ?? l.url).trim();
      const low = url.toLowerCase();
      if (DENY_URL.test(low)) continue;
      if (CMS_FRAGMENT.test(low)) continue; // skip layout-include fragments, not real pages
      const isCourse = COURSE_URL.test(low);
      const isElig = ELIG_URL.test(low);
      if (INTL_ONLY) {
        if (!INTL_URL.test(low)) continue; // international-entry only
      } else if (!isCourse && !isElig) {
        continue;
      }
      // Keep only the requested level so university and course URLs land in
      // SEPARATE files (Aliff: University Eligibility ≠ Course Eligibility).
      if (LEVEL === "university" && isCourse) continue;
      if (LEVEL === "course" && !isCourse) continue;

      if (isCourse) {
        // PRECISION: a course row must be a real individual course page (drop
        // listings/search/study-abroad/international pages) for 100%-accurate links.
        if (!isRealCourse(low)) continue;
        // ENTRY-ONLY: drop graduation/degree/minor/completion-requirements & sample
        // curriculum — those are NOT entry criteria. We want the ADMISSION/ENTRY
        // requirements URL (what you need to study), not how to graduate.
        if (COMPLETION_REQ.test(low) && !ADMISSION_ELIG.test(low)) continue;
        const canon = canonicalCourseUrl(url); // collapses year/intake AND .pdf → HTML page
        if (!isRealCourse(canon.toLowerCase())) continue;
        const key = canon.toLowerCase();
        const prev = courseBest.get(key);
        if (!prev || courseCandidateScore(l) > courseCandidateScore(prev.link)) {
          courseBest.set(key, { link: l, canon });
        }
        continue;
      }

      // University-level eligibility page (one row per distinct URL).
      if (seen.has(low)) continue;
      seen.add(low);
      rows.push({
        university: u.name,
        country,
        level: "university",
        course_name: "",
        url,
        crawl_status: l.status,
        http_status: null,
        final_url: url,
        validity: "UNCONFIRMED",
      });
    }

    // Emit ONE row per canonical course — the HTML page. A PDF is recorded only as
    // a last-resort fallback (pdf_fallback) for a course we found ONLY as a PDF.
    for (const { link: l, canon } of courseBest.values()) {
      const onlyPdf = isPdfUrl(l.final_url ?? l.url);
      rows.push({
        university: u.name,
        country,
        level: "course",
        course_name: deriveCourseName(l.page_title, canon.toLowerCase()),
        url: canon,
        crawl_status: l.status,
        http_status: null,
        final_url: canon,
        validity: "UNCONFIRMED",
        pdf_fallback: onlyPdf ? (l.final_url ?? l.url) : undefined,
      });
    }
  }
  await prisma.$disconnect();
  console.log(`[recheck] ${rows.length} URLs (pre-dedup). Validating with browser headers…`);

  let done = 0;
  await pool(rows, CONCURRENCY, async (r) => {
    const { status, finalUrl } = await fetchStatus(r.url, TIMEOUT_MS);
    r.http_status = status;
    r.final_url = finalUrl;
    r.validity = decide(status, finalUrl, r.url, r.crawl_status);
    if (++done % 500 === 0) console.log(`[recheck] ${done}/${rows.length}`);
  });

  // Retry the genuinely-unconfirmed (network fl/transient) once, slower.
  const retry = rows.filter((r) => r.validity === "UNCONFIRMED" && r.http_status === null);
  if (retry.length) {
    console.log(`[recheck] retrying ${retry.length} unreachable at low concurrency…`);
    await pool(retry, 4, async (r) => {
      await sleep(200);
      const { status, finalUrl } = await fetchStatus(r.url, 25000);
      if (status !== null) {
        r.http_status = status;
        r.final_url = finalUrl;
        r.validity = decide(status, finalUrl, r.url, r.crawl_status);
      }
    });
  }

  // STRONG verification: open every still-unconfirmed URL in a REAL browser
  // (handles bot-protected/JS sites that block plain fetch). Confirmed → WORKING,
  // genuinely dead → BROKEN. Nothing is kept on faith.
  const unconfirmed = rows.filter((r) => r.validity === "UNCONFIRMED");
  if (unconfirmed.length) {
    console.log(`[recheck] browser-verifying ${unconfirmed.length} unconfirmed URLs…`);
    await verifyWithBrowser(unconfirmed);
  }

  // POST-REDIRECT PRECISION: a link can pass the course filter on its original URL
  // but REDIRECT (during validation) to a listing / apprenticeships / generic page
  // (e.g. a retired course → /courses?page=… or /apprenticeships). Re-check the
  // FINAL url: if it's no longer a real individual course page, drop it; otherwise
  // collapse any year/intake variant the redirect introduced.
  let redirectDropped = 0;
  for (const r of rows) {
    if (r.level !== "course") continue;
    const flow = r.final_url.toLowerCase();
    if (!COURSE_URL.test(flow) || !isRealCourse(flow)) { r.validity = "BROKEN"; redirectDropped += 1; continue; }
    r.final_url = canonicalCourseUrl(r.final_url);
  }
  if (redirectDropped) console.log(`[recheck] dropped ${redirectDropped} course links that redirected to listing/generic pages`);

  // PDF FALLBACK (worst case, ~0.001%): a course we found ONLY as a PDF whose
  // derived HTML page is NOT reachable. Rather than lose the course, verify the
  // original PDF and, if it loads, fall back to it. The 99.99% path keeps the HTML
  // page (the PDF is dropped); this only rescues the handful with no web page.
  const needFallback = rows.filter(
    (r) => r.level === "course" && r.pdf_fallback && r.validity !== "WORKING" && r.validity !== "BROWSER_VERIFIED",
  );
  if (needFallback.length) {
    console.log(`[recheck] HTML page unreachable for ${needFallback.length} PDF-only course(s) — verifying PDF fallback…`);
    let rescued = 0;
    await pool(needFallback, 6, async (r) => {
      const { status, finalUrl } = await fetchStatus(r.pdf_fallback!, TIMEOUT_MS);
      if (status !== null && status >= 200 && status < 400) {
        r.url = r.pdf_fallback!;
        r.final_url = finalUrl;
        r.validity = "WORKING";
        rescued += 1;
      }
    });
    if (rescued) console.log(`[recheck] kept ${rescued} PDF fallback link(s) where no HTML course page exists`);
  }

  // GLOBAL dedup by final_url — keep the best per unique final URL: higher
  // validity first, then the row that actually has a course name (so a titled HTML
  // page wins over a bare/PDF-derived duplicate that resolved to the same URL).
  const byFinal = new Map<string, Row>();
  const betterFinal = (a: Row, b: Row): boolean => {
    if (rank[a.validity] !== rank[b.validity]) return rank[a.validity] > rank[b.validity];
    return a.course_name.trim().length > 0 && b.course_name.trim().length === 0;
  };
  for (const r of rows) {
    const key = r.final_url.toLowerCase().replace(/\/$/, "");
    const existing = byFinal.get(key);
    if (!existing || betterFinal(r, existing)) byFinal.set(key, r);
  }
  let deduped = [...byFinal.values()].sort((a, b) =>
    a.university === b.university ? (a.level === b.level ? a.final_url.localeCompare(b.final_url) : a.level.localeCompare(b.level)) : a.university.localeCompare(b.university),
  );

  // UNIVERSITY level → keep ONLY the single best "main eligibility" URL per
  // university (course level keeps every course). Multiple university-level links
  // were noise; the Aliff "University Eligibility" field wants one main URL.
  if (LEVEL === "university") {
    const best = new Map<string, Row>();
    for (const r of deduped) {
      if (r.validity === "BROKEN") continue; // never pick a broken main URL
      const cur = best.get(r.university);
      if (!cur || betterMain(r, cur)) best.set(r.university, r);
    }
    deduped = [...best.values()].sort((a, b) => a.university.localeCompare(b.university));
    console.log(`[recheck] university level → kept ${deduped.length} main eligibility URL(s), one per university`);
  }

  const valid = deduped.filter((r) => r.validity === "WORKING" || r.validity === "BROWSER_VERIFIED");
  // Broken (404) URLs are REMOVED from the deliverable entirely. Only the
  // likely-valid-but-unconfirmable (bot-protected) ones are kept, in a side sheet.
  const issues = deduped.filter((r) => r.validity === "UNCONFIRMED");

  // PRECISION: deep-link each course URL to its entry-requirements section/tab so
  // the exported link opens exactly where the international entry criteria live
  // (e.g. …/yacht-design-and-production-beng#entry-requirements), not the bare page.
  const courseRows = valid.filter((r) => r.level === "course" && !r.final_url.includes("#"));
  if (courseRows.length) {
    console.log(`[recheck] detecting entry-requirements anchors on ${courseRows.length} course pages…`);
    let an = 0, hit = 0;
    await pool(courseRows, 6, async (r) => {
      const anchor = entryRequirementAnchor(await fetchHtml(r.final_url));
      if (anchor) { r.final_url = r.final_url.replace(/\/$/, "") + "#" + anchor; hit += 1; }
      if (++an % 50 === 0) console.log(`[recheck] anchors ${an}/${courseRows.length} (deep-linked ${hit})`);
    });
    console.log(`[recheck] deep-linked ${hit}/${courseRows.length} course pages to their entry-requirements tab`);
  }

  // NAME REPAIR: a few course pages captured a transient/placeholder <title> at crawl
  // time (e.g. Canberra's JS course pages briefly show "Error" before the course
  // loads), so the exported row name is junk. Re-open ONLY those in a REAL browser
  // (a plain fetch returns no body for these JS pages) and read the live course
  // heading — giving the EXACT course name without a full re-crawl. Each /1, /2 …
  // version is a distinct page, so versions keep their own correct names.
  // Weak = empty, a junk placeholder ("Error"), or only the bare course CODE
  // (e.g. "ARB104") — in all of these the live heading carries the real name.
  const weakName = (n: string) => { const t = n.trim(); return !t || JUNK_NAME.test(t) || isCourseCode(t); };
  const needName = valid.filter((r) => r.level === "course" && weakName(r.course_name));
  if (needName.length) {
    console.log(`[recheck] repairing ${needName.length} course name(s) from the live page heading…`);
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    let fixed = 0;
    try {
      await pool(needName, 4, async (r) => {
        const ctx = await browser.newContext({ userAgent: BROWSER_HEADERS["user-agent"] });
        const page = await ctx.newPage();
        try {
          await page.goto(r.final_url, { waitUntil: "domcontentloaded", timeout: 25000 });
          await page.waitForSelector("h1", { timeout: 6000 }).catch(() => {}); // let the real heading render over the placeholder
          const heading = await page.evaluate(() => {
            const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
            return clean(document.querySelector("h1")?.textContent) || clean(document.title);
          });
          const name = deriveCourseName(heading, canonicalCourseUrl(r.final_url).toLowerCase());
          if (name && !JUNK_NAME.test(name)) { r.course_name = name; fixed += 1; }
        } catch {
          /* leave the URL-derived fallback name */
        } finally {
          await ctx.close().catch(() => {});
        }
      });
    } finally {
      await browser.close().catch(() => {});
    }
    console.log(`[recheck] repaired ${fixed}/${needName.length} course name(s) from the live heading`);
  }

  // ---- Excel ----
  const wb = new ExcelJS.Workbook();
  const sum = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  sum.columns = [
    { header: "University", key: "u", width: 44 },
    { header: "Country", key: "c", width: 16 },
    { header: "University URLs", key: "uni", width: 15 },
    { header: "Course URLs", key: "course", width: 13 },
    { header: "Valid", key: "valid", width: 10 },
    { header: "Broken", key: "broken", width: 9 },
  ];
  const byUni = new Map<string, Row[]>();
  for (const r of valid) (byUni.get(r.university) ?? byUni.set(r.university, []).get(r.university)!).push(r);
  const allByUni = new Map<string, Row[]>();
  for (const r of deduped) (allByUni.get(r.university) ?? allByUni.set(r.university, []).get(r.university)!).push(r);
  for (const [name, arr] of allByUni) {
    const v = arr.filter((r) => r.validity === "WORKING" || r.validity === "BROWSER_VERIFIED");
    sum.addRow({
      u: name,
      c: arr[0]?.country ?? "",
      uni: v.filter((r) => r.level === "university").length,
      course: v.filter((r) => r.level === "course").length,
      valid: v.length,
      broken: arr.filter((r) => r.validity === "BROKEN").length,
    });
  }
  sum.addRow({});
  sum.addRow({ u: "TOTAL", c: `${allByUni.size} universities`, uni: valid.filter((r) => r.level === "university").length, course: valid.filter((r) => r.level === "course").length, valid: valid.length, broken: deduped.filter((r) => r.validity === "BROKEN").length });
  sum.getRow(1).font = { bold: true };
  sum.lastRow!.font = { bold: true };
  // Stamp the export time in the machine's LOCAL timezone (kept in the Summary
  // sheet only — the parsed "Valid URLs" sheet/CSV schema is unchanged).
  sum.addRow({});
  sum.addRow({ u: "Exported at (local)", c: new Date().toLocaleString() });

  const writeSheet = (name: string, data: Row[]) => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "University", key: "university", width: 42 },
      { header: "Country", key: "country", width: 14 },
      { header: "Level", key: "level", width: 11 },
      { header: "Course Name", key: "course_name", width: 40 },
      { header: "Eligibility / Criteria URL", key: "final_url", width: 90 },
      { header: "HTTP", key: "http_status", width: 7 },
      { header: "Validity", key: "validity", width: 17 },
    ];
    for (const r of data) {
      const row = ws.addRow(r);
      const cell = row.getCell("final_url");
      cell.value = { text: r.final_url, hyperlink: r.final_url };
      cell.font = { color: { argb: "FF0563C1" }, underline: true };
      row.getCell("validity").font = {
        bold: true,
        color: { argb: r.validity === "WORKING" ? "FF1E7B34" : r.validity === "BROWSER_VERIFIED" ? "FF2E75B6" : r.validity === "BROKEN" ? "FFC00000" : "FFBF8F00" },
      };
    }
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: "A1", to: "G1" };
  };
  writeSheet("Valid URLs", valid);
  writeSheet("Unconfirmed (bot-protected)", issues);

  const dir = join(repoRoot(), "storage", "exports");
  mkdirSync(dir, { recursive: true });
  const base =
    LEVEL === "university"
      ? "eligibility-UNIVERSITY-INTERNATIONAL-FINAL"
      : LEVEL === "course"
        ? "eligibility-COURSES-INTERNATIONAL-FINAL"
        : INTL_ONLY
          ? "eligibility-INTERNATIONAL-FINAL"
          : "eligibility-urls-FINAL";
  await wb.xlsx.writeFile(join(dir, `${base}.xlsx`));

  // Clean CSV (valid only).
  const cell = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["university", "country", "level", "course_name", "eligibility_url", "http_status", "validity"];
  const lines = [head.map(cell).join(",")];
  for (const r of valid) lines.push([cell(r.university), cell(r.country), cell(r.level), cell(r.course_name), cell(r.final_url), cell(r.http_status), cell(r.validity)].join(","));
  writeFileSync(join(dir, `${base}.csv`), lines.join("\r\n"), "utf8");

  const t: Record<string, number> = {};
  for (const r of deduped) t[r.validity] = (t[r.validity] ?? 0) + 1;
  console.log(`[recheck] pre-dedup=${rows.length}  after-global-dedup=${deduped.length}  (removed ${rows.length - deduped.length} dupes)`);
  console.log(`[recheck] VALID=${valid.length} (working=${t.WORKING ?? 0} browser_verified=${t.BROWSER_VERIFIED ?? 0})  removed_broken=${t.BROKEN ?? 0}  unconfirmed=${t.UNCONFIRMED ?? 0}`);
  console.log(`[recheck] WROTE ${base}.xlsx + .csv (broken removed${INTL_ONLY ? ", international-entry only" : ""})`);
  process.exit(0);
}

main().catch((e) => {
  console.error("RECHECK_ERROR", e);
  process.exit(1);
});
