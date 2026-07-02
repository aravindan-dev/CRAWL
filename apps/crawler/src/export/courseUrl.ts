/**
 * Course-URL precision helpers (shared by the exporter + its tests).
 *
 * HTML-FIRST policy: the deliverable for a course is its HTML web page — the page
 * a human opens, where the entry/admission requirements live inline. A downloadable
 * `.pdf` prospectus is NEVER the deliverable; it collapses to the HTML page it
 * belongs to and is kept only as a worst-case fallback. These helpers also handle
 * CODE-based course URLs (e.g. Canberra's …/course/MGM102/2/2026) where the course
 * is identified by a compact alphanumeric code instead of a word-slug.
 */

// Drop pages that are NOT an individual course: search/listing pages (query
// strings), study-abroad, international/visa/country pages (those are university
// level), and bare listing roots. CPD + short courses ARE included (user choice).
const COURSE_DENY =
  /(\?|\/abroad\b|study[-_]?abroad|international[-_]?students?|your[-_]?country|country[-_]?or[-_]?territory|\/countries?\/|english[-_]?language|\/visa\b|\/course[-_]?enquiry|\/search\b|\/compare\b|\/clearing\b|\/open[-_]?days?\b|directory|\ba-z\b|apply[-_]?for|how[-_]?to[-_]?apply|\/fees?\b|\/funding\b|\/term[-_]?dates?\b|course[-_]?dates?|course[-_]?fees?|tuition[-_]?fees?|\bscholarships?\b|\bbursar(?:y|ies)\b|key[-_]?dates?|intake[-_]?dates?|important[-_]?dates?|(left|right|main|top|bottom|side|centre|center|mid)[-_]col(umn)?[-_]content|\/index\.(php|html?|aspx)|thank[-_]?you|sponsored[-_]and[-_]self[-_]funded|self[-_]funded[-_]places|visiting[-_](research|students?))/i;
const LISTING_END =
  /\/(courses?|programmes?|programs?|study|studies|subjects?|undergraduate|postgraduate|graduate|degrees?|abroad|programs?-and-courses|programs?-courses|a-z|all)\/?$/i;
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
  // CMS / student-portal container segments — never the course identifier.
  "content", "home", "myuc", "portal", "info", "information",
  // Broken-link markers (unpopulated slug variables) — never a course name.
  "undefined", "null", "nan",
]);
// Student-ADMIN / process pages that can sit under a /course/ path but are NOT a
// course: changing / pausing (intermission) / withdrawing / deferring study,
// applications for special arrangements, the student portal (myuc), credit transfer
// / RPL. These leaked into the COURSE deliverable as .html form pages — e.g. canberra
// …/course/course-changes/application-for-intermission.html, whose page is actually a
// login / identity-provider redirect, never a course.
const ADMIN_PROCESS =
  /(intermission|course[-_]?changes?|change[-_]?of[-_]?(?:course|programme?|program|enrol(?:ment)?|major|preference)|leave[-_]?of[-_]?absence|withdraw(?:al|ing)?|deferr?(?:al|ment|ing|red)?|re[-_]?enrol(?:ment|ling)?|readmission|special[-_]?consideration|application[-_]?for[-_]?(?:intermission|leave|credit|withdrawal|deferral|admission|extension|special)|enrol(?:ment)?[-_]?(?:variation|change|status|cancellation)|\/myuc(?:[\/_-]|$)|credit[-_]?transfer|recognition[-_]?of[-_]?prior[-_]?learning)/i;
const TITLE_GENERIC =
  /(application information|frequently asked|^faq|^home$|^search|^courses?$|^programmes?$|overview|page not found|not found|^404|enquiry|^undergraduate$|^postgraduate$|cookie|^study$|^short courses?( and cpd)?$|^cpd$|^research degrees?$|^(admission|entry|graduation|degree|minor) requirements?$|^admission requirements\b|^graduation requirements\b|^error$|^loading$|^untitled$|^redirecting$|please wait|just a moment|^forbidden$|access denied|identity provider|production idp)/i;
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

// A compact alphanumeric course CODE that names an individual course even though
// it has NO word-slug — e.g. Canberra's MGM102, ABAB01, 245JA, 723AA, ARAR02.
// Letters+digits in either order; never a bare year (20xx). This is what lets a
// code-based course page (…/course/245JA/3/2026) be recognised as a real course —
// previously only the ".pdf" variant slipped through (its "pdf" faked a word), so
// the PDF was exported instead of the HTML page.
const COURSE_CODE = /^(?:[a-z]{2,6}\d{1,4}|\d{2,4}[a-z]{2,4})$/i;
export function isCourseCode(seg: string): boolean {
  return COURSE_CODE.test(seg) && !/^20\d\d$/.test(seg);
}
/** Path segments with `.html/.php/.aspx/.pdf` extensions stripped. */
function courseSegments(low: string): string[] {
  return new URL(low).pathname
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/\.(html?|php|aspx|pdf)$/i, ""));
}
/** A segment that identifies a specific course: a word-slug OR a course code. */
function isSpecificSegment(s: string): boolean {
  if (GENERIC_SEG.has(s.toLowerCase())) return false;
  if (/^\d+$/.test(s) || /^20\d\d$/.test(s)) return false; // pure number / year
  return /[a-z]{3,}/i.test(s) || isCourseCode(s);
}
// A literal "undefined" path segment is a broken CMS/JS link (the slug variable
// was never populated) — e.g. handbook /course/undefined/4408HO01. These 404 and
// must never be treated as a course.
const BROKEN_SLUG = /\/(undefined|null|nan|\[object%20object\])(\/|$)/i;

/** A real, individual course page (not a listing/search/generic/international page). */
export function isRealCourse(low: string): boolean {
  if (BROKEN_SLUG.test(low)) return false; // /undefined/ etc. — broken link, always drop
  if (COURSE_DENY.test(low)) return false;
  if (ADMIN_PROCESS.test(low)) return false; // student-admin/process page, not a course
  if (LISTING_END.test(low)) return false;
  try {
    return courseSegments(low).some(isSpecificSegment);
  } catch {
    return false;
  }
}
export function courseNameFromUrl(low: string): string {
  try {
    const cands = courseSegments(low).filter(isSpecificSegment);
    if (!cands.length) return "";
    const withDeg = cands.find((c) => DEGREE.test(c));
    // Prefer a degree word, then a word-slug; fall back to the course code last.
    const words = cands.filter((c) => !isCourseCode(c));
    const pick = withDeg ?? [...(words.length ? words : cands)].sort((a, b) => b.length - a.length)[0]!;
    return isCourseCode(pick) ? pick.toUpperCase() : titleize(pick);
  } catch {
    return "";
  }
}
// The AWARD LEVEL (Bachelor / Master / Doctor / Associate) encoded in a course
// string. The URL slug is authoritative for the award — …/master-teaching-primary
// is unambiguously a Master — so when a captured page <title> disagrees with the
// slug (e.g. a stale or placeholder "Bachelor …" title on a /courses/master-… page)
// the URL wins. The exported name must NEVER contradict the URL it points to.
const AWARD_GROUPS: [RegExp, string][] = [
  [/\b(doctor|doctorate|phd|dphil|edd|dba)\b/i, "doctor"],
  [/\b(masters?|msc|meng|mba|mphil|mres|ma|ms|llm)\b/i, "master"],
  [/\b(bachelor|bsc|beng|bba|llb|ba|bs)\b/i, "bachelor"],
  [/\bassociate\b/i, "associate"],
];
function awardGroup(s: string): string | null {
  for (const [re, g] of AWARD_GROUPS) if (re.test(s)) return g;
  return null;
}

/** Course name: clean page title (before site name) if meaningful, else URL slug. */
export function deriveCourseName(title: string | null, low: string): string {
  const urlName = courseNameFromUrl(low);
  const t = (title ?? "").trim();
  if (t && !TITLE_GENERIC.test(t)) {
    const cleaned = t
      .split("|")[0]!
      .split(" - ")[0]!
      .replace(/\s+20\d\d\b.*$/, "")
      .replace(/\s+(full[-\s]?time|part[-\s]?time|distance learning|online)\b.*$/i, "")
      .trim();
    if (cleaned.length >= 3) {
      // NAME MUST MATCH THE URL: if the title's award level contradicts the slug's
      // (a "Bachelor …" title on a …/master-… URL), trust the URL, not the title.
      const ug = awardGroup(low);
      const tg = awardGroup(cleaned);
      if (urlName && ug && tg && ug !== tg) return urlName;
      return cleaned;
    }
  }
  return urlName;
}

/**
 * Collapse every year / intake / PDF variant of a course to ONE canonical HTML
 * landing page, so each course appears ONCE and the deliverable is the web page:
 *   /courses/ug/yacht-beng/2026/…        -> /courses/ug/yacht-beng
 *   /course/723AA/6/2024                 -> /course/723AA/6
 *   /course/723AA/6/2024.pdf  (prospectus) -> /course/723AA/6   (HTML, not PDF)
 * Strips query + hash too.
 */
export function canonicalCourseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.search = "";
    let segs = u.pathname.split("/").filter(Boolean);
    // HTML-FIRST: a PDF prospectus (…/2024.pdf, …/prospectus.pdf) collapses to the
    // HTML course page it belongs to, so a `.pdf` and the real web page dedupe to
    // ONE row and the deliverable is always the URL, never the PDF.
    if (segs.length && /\.pdf$/i.test(segs[segs.length - 1]!)) segs = segs.slice(0, -1);
    const cut = segs.findIndex((s) => /^(years?|20\d\d)$/i.test(s));
    u.pathname = "/" + (cut === -1 ? segs : segs.slice(0, cut)).join("/");
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}
