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
];

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
