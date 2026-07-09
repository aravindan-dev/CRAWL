import { env, isSameDomain, urlDepth, getKeywords, keywordsToRegex, CrawlContext } from "@clg/shared";

/**
 * Link scoring (Section 14), now driven by the CENTRAL keyword vocabulary
 * (@clg/shared keywords — defaults + user-added from the dashboard). Eligibility
 * and international signals come from the editable lists; course/structural
 * signals stay built-in. Loaded once at startup (restart the crawler to pick up
 * keyword edits).
 */
const KW = getKeywords();
const INTL_RE = keywordsToRegex(KW.international);
const ELIG_RE = keywordsToRegex(KW.eligibility);
const SCH_RE = keywordsToRegex(KW.scholarship);

// Structural course signals (additive, lower weight).
const COURSE_SCORES: { re: RegExp; score: number }[] = [
  { re: /undergraduate/i, score: 20 },
  { re: /(postgraduate|post[-\s]?graduate)/i, score: 20 },
  { re: /\b(bachelors?|bsc|b\.?a\b|beng|bba|llb)\b/i, score: 20 },
  { re: /\b(masters?|m\.?sc|m\.?a\b|mba|meng|ph\.?d|doctoral)\b/i, score: 20 },
  { re: /degrees?/i, score: 15 },
  { re: /programm?es?/i, score: 15 },
  { re: /courses?/i, score: 15 },
  { re: /(foundation|pathway)/i, score: 15 },
  { re: /apply/i, score: 10 },
  { re: /study/i, score: 10 },
  { re: /faculty/i, score: 8 },
  { re: /department/i, score: 8 },
  // Fuller course vocabulary (sell §285): catalogue/prospectus/handbook are the
  // canonical course-inventory pages; study-options / specialisation / subject
  // hubs and schools/colleges lead to course listings. Additive discovery weight
  // only — a page reachable via these still passes classification + context
  // authorization + target validation before it can ever be exported.
  { re: /(catalogu?e|prospectus|handbook)/i, score: 15 },
  { re: /study[-\s]?options?/i, score: 12 },
  { re: /(specialisation|specialization)/i, score: 12 },
  { re: /qualifications?/i, score: 10 },
  { re: /subjects?/i, score: 8 },
  { re: /(school|college)s?/i, score: 8 },
];

// Anchor-text intelligence (sell §382): call-to-action phrases that lead to a
// course hub/finder even when the URL itself is opaque ("/study", "/s/1234").
// Applied to the ANCHOR text only, modest weight — a discovery hint, never a
// substitute for target validation.
const COURSE_ANCHOR =
  /explore (?:our )?(?:courses|programm?es|degrees)|find (?:your|a) (?:course|degree|programm?e)|search (?:courses|programm?es|degrees)|browse (?:courses|programm?es)|study with us|what can i study|all (?:degrees|courses|programm?es)|view (?:courses|programm?es|degrees)|course catalogu?e|program(?:me)? finder|study options|areas? of study/i;

export interface ScoreInput {
  url: string;
  anchorText: string;
  nearbyText?: string;
  baseUrl: string;
  /** The active crawl context. Scoring weights the context's own signals; when
   *  omitted, the process-wide CRAWL_TARGET is used (legacy callers). Scoring is
   *  RELEVANCE only — crawl authorization (classification vs context) runs
   *  separately and always outranks the score. */
  context?: CrawlContext;
}

export interface ScoreResult {
  score: number;
  matched: string[];
}

/**
 * Score a candidate link. International (+45) and eligibility (+40) come from the
 * editable keyword lists; course signals are additive; same-domain (+15) and
 * shallow depth (+5) bonuses apply.
 */
// Structural eligibility signal: a URL/anchor segment like /admission(s),
// /requirements, /entry-requirements, /eligibility, /how-to-apply — catches
// dedicated requirements pages even when the full keyword PHRASES don't match
// (e.g. a bare ".../requirements" or ".../admission-requirements.html").
const STRUCT_ELIG = /(^|[\/\-_ ])(admission|admissions|entry[\s\-_]?requirements?|requirements?|eligibility|how[\s\-_]?to[\s\-_]?apply|entry[\s\-_]?profile)([\/\-_. ]|$)/i;
// ENTRY requirements = what you need to GET IN (what we want).
const ADMISSION_ELIG = /(admission|entry)[\s\-_]?(requirement|criteri|profile)|how[\s\-_]?to[\s\-_]?apply|\/admissions?\b|entry[\s\-_]?requirements?/i;
// COMPLETION requirements = what you need to GRADUATE / finish — NOT entry
// criteria. graduation/degree/minor/completion requirements, sample curriculum,
// "degrees available" are explicitly NOT eligibility pages.
const ANTI_ELIG = /(graduation|degree|minor|completion|major|honou?rs)[\s\-_]?requirements?|sample[\s\-_]?curriculum|degrees?[\s\-_]?available|course[\s\-_]?content|module[\s\-_]?(list|catalog)/i;

// Legacy fallback when no per-crawl context is passed: the process-wide
// CRAWL_TARGET setting. Per-job crawl contexts (ScoreInput.context) take
// precedence so one engine process can run both contexts concurrently.
const TARGET = env.CRAWL_TARGET;

export function scoreLink(input: ScoreInput): ScoreResult {
  const wantElig = input.context ? input.context === CrawlContext.ELIGIBILITY : TARGET !== "scholarship";
  const wantSch = input.context ? input.context === CrawlContext.SCHOLARSHIP : TARGET !== "eligibility";
  const haystack = `${input.url} ${input.anchorText} ${input.nearbyText ?? ""}`;
  let score = 0;
  const matched: string[] = [];

  const isAdmission = ADMISSION_ELIG.test(haystack);
  // A graduation/degree/minor/completion-requirements page is NOT an entry page —
  // unless it's also explicitly admission/entry. Such pages get no eligibility
  // bonus, so admission/entry-requirements always outrank them.
  const isCompletionOnly = ANTI_ELIG.test(haystack) && !isAdmission;
  if (wantElig && !isCompletionOnly) {
    if (INTL_RE.test(haystack)) { score += 45; matched.push("international"); }
    if (ELIG_RE.test(haystack)) { score += 40; matched.push("eligibility"); }
    else if (STRUCT_ELIG.test(haystack)) { score += 32; matched.push("eligibility-structural"); }
    if (isAdmission) { score += 18; matched.push("admission-entry"); } // entry pages beat other requirement pages
  }
  // Scholarship pages are exported separately from eligibility.
  if (wantSch && SCH_RE.test(haystack)) { score += 38; matched.push("scholarship"); }
  for (const { re, score: s } of COURSE_SCORES) {
    if (re.test(haystack)) { score += s; matched.push(re.source); }
  }
  if (COURSE_ANCHOR.test(input.anchorText)) { score += 12; matched.push("course-anchor"); }
  if (isSameDomain(input.url, input.baseUrl)) { score += 15; matched.push("same-domain"); }
  if (urlDepth(input.url) <= 3) { score += 5; matched.push("shallow-depth"); }

  return { score, matched };
}

export const QUEUE_THRESHOLD = 40; // >= : queue for extraction
export const DISCOVER_THRESHOLD = 20; // 20..39 : crawl for discovery only

export type LinkDisposition = "EXTRACT" | "DISCOVER_ONLY" | "SKIP";

/** Section 15 queue rules. */
export function dispositionFor(score: number, minLinkScore = QUEUE_THRESHOLD): LinkDisposition {
  if (score >= minLinkScore) return "EXTRACT";
  if (score >= DISCOVER_THRESHOLD) return "DISCOVER_ONLY";
  return "SKIP";
}

// ---------------------------------------------------------------------------
// V4 — Smart Candidate Scoring (pre-fetch relevance estimation)
// ---------------------------------------------------------------------------

/** Evidence signals that appear in page text / anchor text / nearby text. */
const EVIDENCE_RE = /\b(ielts|toefl|pte|cambridge|gpa|qualification|english[-\s]?language|academic[-\s]?requirements?|entry[-\s]?requirements?)\b/i;

export interface CandidateScoreInput {
  url: string;
  anchorText: string;
  nearbyText?: string;
  officialDomain: string;
}

/**
 * V4 candidate scoring formula. Produces a 0-145 score representing the
 * estimated likelihood that fetching this URL will yield useful content.
 *
 *  - Official domain:         +30
 *  - Admission keyword:       +25
 *  - International keyword:   +20
 *  - Scholarship keyword:     +20
 *  - Course keyword:          +20
 *  - Content evidence:        +30
 *
 * Decision rules (caller enforces):
 *  - score >= 90 → fetch immediately
 *  - 70 <= score < 90 → queue
 *  - score < 70 → ignore
 */
export function scoreCandidate(input: CandidateScoreInput): { score: number; decision: "FETCH" | "QUEUE" | "IGNORE" } {
  const haystack = `${input.url} ${input.anchorText} ${input.nearbyText ?? ""}`;
  let score = 0;

  // Official domain
  if (input.officialDomain) {
    try {
      const host = new URL(input.url).hostname.toLowerCase();
      if (host === input.officialDomain || host.endsWith(`.${input.officialDomain}`)) score += 30;
    } catch { /* malformed URL — no bonus */ }
  }

  // Admission keyword
  if (ADMISSION_ELIG.test(haystack)) score += 25;

  // International keyword
  if (INTL_RE.test(haystack)) score += 20;

  // Scholarship keyword
  if (SCH_RE.test(haystack)) score += 20;

  // Course keyword (any of the course signals)
  if (COURSE_SCORES.some(({ re }) => re.test(haystack))) score += 20;

  // Content evidence (concrete vocabulary like IELTS, GPA, etc.)
  if (EVIDENCE_RE.test(haystack)) score += 30;

  const decision = score >= 90 ? "FETCH" as const : score >= 70 ? "QUEUE" as const : "IGNORE" as const;
  return { score, decision };
}

// ---------------------------------------------------------------------------
// V4 — Priority Queue Classification (P0 → P1 → P2)
// ---------------------------------------------------------------------------

import type { PageClass } from "@clg/shared";

/** Priority tiers — lower number = higher priority. */
export type CrawlPriority = 0 | 1 | 2;

/** P0 (critical) PageClass values. */
const P0_CLASSES = new Set([
  "ELIGIBILITY_PAGE",
  "INTERNATIONAL_ADMISSIONS_PAGE",
  "ADMISSIONS_PAGE",
  "SCHOLARSHIP_PAGE",
  "SCHOLARSHIP_LISTING",
  "FUNDING_PAGE",
]);

/** P1 (important) PageClass values. */
const P1_CLASSES = new Set([
  "COURSE_PAGE",
  "COURSE_LISTING",
]);

/**
 * Classify a discovered link into a priority tier for queue ordering.
 *
 *  - P0 Critical (0): Eligibility, International admissions, Admissions,
 *    Scholarships, Funding — fetched first.
 *  - P1 Important (1): Course pages, Course listings, Faculty pages.
 *  - P2 Deep (2): Everything else (navigation, unknown, departments).
 */
export function getPriority(pageClass: PageClass, url: string, anchorText: string): CrawlPriority {
  if (P0_CLASSES.has(pageClass)) return 0;
  if (P1_CLASSES.has(pageClass)) return 1;

  // Promote navigation pages that look like faculty/school hubs to P1 —
  // they often link to course listings and eligibility pages.
  if (pageClass === "NAVIGATION_PAGE") {
    const hay = `${url} ${anchorText}`.toLowerCase();
    if (/facult|school|college|department/i.test(hay)) return 1;
  }

  return 2;
}
