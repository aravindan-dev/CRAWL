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
import { repoRoot, getKeywords, keywordsToRegex } from "@clg/shared";

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
// Drop pages that are NOT an individual course: search/listing pages (query
// strings), study-abroad, international/visa/country pages (those are university
// level), and bare listing roots.
// NOTE: CPD + short courses ARE included in the deliverable (user choice). Only
// genuine NON-courses are denied here: study-abroad/country/visa (university level),
// search/compare/listing pages, CMS fragments, thank-you, funding/admin pages and
// visiting-students info. (short-courses-and-cpd is NOT denied.)
const COURSE_DENY =
  /(\?|\/abroad\b|study[-_]?abroad|international[-_]?students?|your[-_]?country|country[-_]?or[-_]?territory|\/countries?\/|english[-_]?language|\/visa\b|\/course[-_]?enquiry|\/search\b|\/compare\b|\/clearing\b|\/open[-_]?days?\b|directory|\ba-z\b|apply[-_]?for|how[-_]?to[-_]?apply|\/fees?\b|\/funding\b|\/term[-_]?dates?\b|(left|right|main|top|bottom|side|centre|center|mid)[-_]col(umn)?[-_]content|\/index\.(php|html?|aspx)|thank[-_]?you|sponsored[-_]and[-_]self[-_]funded|self[-_]funded[-_]places|visiting[-_](research|students?))/i;
const LISTING_END =
  /\/(courses?|programmes?|programs?|study|studies|subjects?|undergraduate|postgraduate|graduate|degrees?|abroad|programs?-and-courses|programs?-courses|a-z|all)\/?$/i;
// ENTRY requirements = what you need to GET IN (the deliverable we want).
const ADMISSION_ELIG = /(admission|entry)[-_ ]?(requirement|criteri|profile)|how[-_ ]?to[-_ ]?apply|\/admissions?\b|entry[-_ ]?requirements?/i;
// COMPLETION requirements = graduation/degree/minor/completion — NOT entry. The
// user needs the ADMISSION/ENTRY page (criteria to study), not how to graduate.
const COMPLETION_REQ = /(graduation|degree|minor|completion|major|honou?rs)[-_ ]?requirements?|sample[-_ ]?curriculum|degrees?[-_ ]?available|course[-_ ]?content|module[-_ ]?(list|catalog)/i;
const GENERIC_SEG = new Set([
  "courses", "course", "programmes", "programme", "programs", "program", "study", "studies",
  "subjects", "subject", "undergraduate", "postgraduate", "graduate", "ug", "pg", "degrees",
  "degree", "abroad", "en", "international", "international-students", "faculties", "faculty",
  "department", "departments", "schools", "school", "academics", "programs-and-courses",
  "programs-courses", "degree-apprenticeships", "degree-apprenticeship", "research-degrees", "research-degree", "short-courses-and-cpd", "short-courses", "short-course", "cpd", "types-of-study", "full-time", "part-time", "fulltime", "parttime",
  "distance-learning", "online", "overview", "how-to-apply", "fees", "apply", "find-a-course",
  // requirement-type page slugs: the course NAME should come from the PROGRAM
  // segment (e.g. "mechatronics"), not the page ("admission-requirements").
  "admission-requirements", "entry-requirements", "graduation-requirements",
  "degree-requirements", "minor-requirements", "completion-requirements",
  "sample-curriculum", "degrees-available", "requirements", "admission", "admissions",
  "graduation", "curriculum", "entry-profile",
]);
const TITLE_GENERIC =
  /(application information|frequently asked|^faq|^home$|^search|^courses?$|^programmes?$|overview|page not found|not found|^404|enquiry|^undergraduate$|^postgraduate$|cookie|^study$|^short courses?( and cpd)?$|^cpd$|^research degrees?$|^(admission|entry|graduation|degree|minor) requirements?$|^admission requirements\b|^graduation requirements\b)/i;
const DEGREE = /(bsc|beng|bba|llb|bachelor|master|msc|meng|mba|\bma\b|\bba\b|honou?rs|diploma|certificate|minor|phd|foundation|doctorate|associate)/i;
const NAME_ABBR: Record<string, string> = {
  bsc: "BSc", ba: "BA", beng: "BEng", bba: "BBA", llb: "LLB", bs: "BS", msc: "MSc", ma: "MA",
  mba: "MBA", phd: "PhD", meng: "MEng", ms: "MS", llm: "LLM", mphil: "MPhil", hons: "Hons",
};
const CONNECTORS = new Set([
  "and", "or", "of", "the", "with", "in", "for", "to", "at", "on", "a", "an", "as", "by", "from", "into",
]);
function titleize(slug: string): string {
  return slug
    .replace(/\.(html?|php|aspx)$/i, "")
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (NAME_ABBR[lw]) return NAME_ABBR[lw]; // BSc, MSc, MBA…
      if (i > 0 && CONNECTORS.has(lw)) return lw; // and, of, with… (lower, mid-name)
      if (w.length <= 3) return w.toUpperCase(); // acronyms / codes: AAS, MS, PRC
      return w[0]!.toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ")
    .trim();
}
/** A real, individual course page (not a listing/search/generic/international page). */
function isRealCourse(low: string): boolean {
  if (COURSE_DENY.test(low)) return false;
  if (LISTING_END.test(low)) return false;
  try {
    const segs = new URL(low).pathname.split("/").filter(Boolean).map((s) => s.replace(/\.(html?|php|aspx)$/i, ""));
    const specific = segs.filter(
      (s) => !GENERIC_SEG.has(s.toLowerCase()) && /[a-z]{3,}/i.test(s) && !/^\d+$/.test(s) && !/^20\d\d$/.test(s),
    );
    return specific.length > 0;
  } catch {
    return false;
  }
}
function courseNameFromUrl(low: string): string {
  try {
    const segs = new URL(low).pathname.split("/").filter(Boolean).map((s) => s.replace(/\.(html?|php|aspx)$/i, ""));
    const cands = segs.filter(
      (s) => !GENERIC_SEG.has(s.toLowerCase()) && /[a-z]{3,}/i.test(s) && !/^\d+$/.test(s) && !/^20\d\d$/.test(s),
    );
    if (!cands.length) return "";
    const withDeg = cands.find((c) => DEGREE.test(c));
    const pick = withDeg ?? [...cands].sort((a, b) => b.length - a.length)[0]!;
    return titleize(pick);
  } catch {
    return "";
  }
}
/** Course name: clean page title (before site name) if meaningful, else URL slug. */
function deriveCourseName(title: string | null, low: string): string {
  const t = (title ?? "").trim();
  if (t && !TITLE_GENERIC.test(t)) {
    const cleaned = t
      .split("|")[0]!
      .split(" - ")[0]!
      .replace(/\s+20\d\d\b.*$/, "")
      .replace(/\s+(full[-\s]?time|part[-\s]?time|distance learning|online)\b.*$/i, "")
      .trim();
    if (cleaned.length >= 3) return cleaned;
  }
  return courseNameFromUrl(low);
}

// Crawl statuses that mean the real browser successfully LOADED the page.
const BROWSER_LOADED = new Set([
  "VALID_COURSE_PAGE",
  "VALID_ADMISSION_PAGE",
  "POSSIBLE_REQUIREMENT_PAGE",
  "LOW_CONFIDENCE_PAGE",
  "NOT_RELEVANT",
  "REDIRECTED",
]);

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
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Canonical course URL: collapse year / intake variants to ONE landing page -
// e.g. /courses/ug/yacht-beng, /courses/ug/yacht-beng/2026/…, /courses/ug/
// yacht-beng/years/2021/… all collapse to /courses/ug/yacht-beng so each course
// appears ONCE (not once per intake/year). Strips query + hash too.
function canonicalCourseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.search = "";
    const segs = u.pathname.split("/").filter(Boolean);
    const cut = segs.findIndex((s) => /^(years?|20\d\d)$/i.test(s));
    u.pathname = "/" + (cut === -1 ? segs : segs.slice(0, cut)).join("/");
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

// --- Deep-link course URLs to their ENTRY-REQUIREMENTS section/tab -------------
// Most course pages keep entry requirements in a same-page tab whose anchor id
// varies by university (#entry-requirements, #entry-criteria, #admission-
// requirements, #how-to-apply, #international-entry-requirements, …). Rather than
// hardcode them, we match the page's anchor ids against the EDITABLE eligibility
// (and international) keyword vocabulary — so adding a keyword in Settings widens
// anchor detection too. A preference order picks the most specific / international
// entry section when several match.
const ELIG_ANCHOR_RE = keywordsToRegex(KW.eligibility);
const INTL_ANCHOR_RE = keywordsToRegex(KW.international);
const ANCHOR_PREF: RegExp[] = [
  /international.*(requirement|criteri|entry|eligib|qualif)/i, // international-specific entry section (best)
  /entry[-_ ]?requirement/i,
  /entry[-_ ]?criteri/i,
  /admission[-_ ]?requirement/i,
  /admission[-_ ]?criteri/i,
  /academic[-_ ]?requirement/i,
  /how[-_ ]?to[-_ ]?apply/i,
  /entry[-_ ]?profile/i,
  /\brequirement/i,
  /\beligib/i,
  /\badmission/i,
  /\bentry\b/i,
];
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
// UI-chrome prefixes: the deep-link target is the SECTION id (e.g.
// "entry-requirements"), not the tab BUTTON / panel wrapper id
// ("tab-entry-requirements", "panel-…"). Prefer the clean section id.
const CHROME_AFFIX = /^(tab|tabs|panel|pane|accordion|collapse|collapsible|btn|button|heading|header|hdr|title|nav|navtab|link|section|sect|content|target|jump|toggle|menu|item|trigger|control|aria)[-_]|[-_](tab|panel|pane|btn|button|link|heading|header|trigger|content)$/;
/**
 * Best entry-requirements anchor id on a page, chosen from the page's own anchor
 * ids using the editable keyword vocabulary. Prefers the clean section id over a
 * tab/panel wrapper, and the most specific match (international-entry >
 * entry-requirements > … > entry). Returns null if none match.
 */
function anchorFromHtml(html: string): string | null {
  if (!html) return null;
  // (A) Prefer an explicit jump-link whose VISIBLE TEXT is about entry requirements.
  // Many templates use OPAQUE section ids (e.g. #c161699) with the label only in the
  // link text ("Fees and entry requirements"), so id-matching alone misses them.
  const labelPref: RegExp[] = [
    /international[^<]*(?:entry|requirement|criteri|eligib|qualif)/i,
    /entry[\s-]*requirements?/i,
    /entry[\s-]*criteri/i,
    /admission[\s-]*requirements?/i,
    /fees?\s*(?:and|&|\/)?\s*entry[\s-]*requirements?/i,
    /how[\s-]*to[\s-]*apply/i,
    /\bentry\b[^<]*requirement/i,
  ];
  const labelled: { target: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']#([A-Za-z0-9_-]{2,60})["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = m[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (/entry|admission|requirement|criteri|eligib|how to apply/i.test(text)) labelled.push({ target: m[1]!.toLowerCase(), text });
  }
  for (const pref of labelPref) {
    const hit = labelled.find((l) => pref.test(l.text));
    if (hit) return hit.target;
  }
  // (B) Fall back to matching anchor IDS against the eligibility vocabulary.
  const ids = new Set<string>();
  for (const m of html.matchAll(/(?:\bid|\bname)\s*=\s*["']([A-Za-z0-9_-]{3,60})["']/g)) ids.add(m[1]!.toLowerCase());
  for (const m of html.matchAll(/href\s*=\s*["']#([A-Za-z0-9_-]{3,60})["']/g)) ids.add(m[1]!.toLowerCase());
  // Candidates = anchor ids that match the eligibility vocabulary, OR an
  // international anchor clearly about entry/requirements/qualifications.
  const all = [...ids].filter(
    (id) => ELIG_ANCHOR_RE.test(id) || (INTL_ANCHOR_RE.test(id) && /requirement|criteri|entry|eligib|qualif|admission/i.test(id)),
  );
  if (!all.length) return null;
  const pick = (list: string[]): string | undefined => {
    for (const pref of ANCHOR_PREF) { const hit = list.find((id) => pref.test(id)); if (hit) return hit; }
    return [...list].sort((a, b) => a.length - b.length)[0]; // else the shortest (cleanest) match
  };
  const clean = all.filter((id) => !CHROME_AFFIX.test(id));
  return (clean.length ? pick(clean) : pick(all)) ?? null;
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
    const seen = new Set<string>();
    for (const l of links) {
      let url = (l.final_url ?? l.url).trim();
      let low = url.toLowerCase();
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
      // PRECISION: a course row must be a real individual course page (drop
      // listings/search/study-abroad/international pages) for 100%-accurate links.
      if (isCourse && !isRealCourse(low)) continue;
      // ENTRY-ONLY: drop graduation/degree/minor/completion-requirements & sample
      // curriculum — those are NOT entry criteria. We want the ADMISSION/ENTRY
      // requirements URL (what you need to study), not how to graduate.
      if (isCourse && COMPLETION_REQ.test(low) && !ADMISSION_ELIG.test(low)) continue;
      // Collapse year/intake variants of a course to ONE canonical landing page.
      if (isCourse) {
        url = canonicalCourseUrl(url);
        low = url.toLowerCase();
        if (!isRealCourse(low)) continue;
      }
      if (seen.has(low)) continue;
      seen.add(low);
      rows.push({
        university: u.name,
        country: u.country,
        level: isCourse ? "course" : "university",
        course_name: isCourse ? deriveCourseName(l.page_title, low) : "",
        url,
        crawl_status: l.status,
        http_status: null,
        final_url: url,
        validity: "UNCONFIRMED",
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

  // GLOBAL dedup by final_url — keep the best validity per unique final URL.
  const byFinal = new Map<string, Row>();
  for (const r of rows) {
    const key = r.final_url.toLowerCase().replace(/\/$/, "");
    const existing = byFinal.get(key);
    if (!existing || rank[r.validity] > rank[existing.validity]) byFinal.set(key, r);
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
      const anchor = anchorFromHtml(await fetchHtml(r.final_url));
      if (anchor) { r.final_url = r.final_url.replace(/\/$/, "") + "#" + anchor; hit += 1; }
      if (++an % 50 === 0) console.log(`[recheck] anchors ${an}/${courseRows.length} (deep-linked ${hit})`);
    });
    console.log(`[recheck] deep-linked ${hit}/${courseRows.length} course pages to their entry-requirements tab`);
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
