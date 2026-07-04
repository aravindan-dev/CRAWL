/**
 * CRAWL AUTHORIZATION — "may this kind of page be fetched in the current crawl
 * context?". This is the policy gate that enforces strict eligibility/
 * scholarship isolation. It runs BEFORE a URL may enter the request queue and
 * again (defensively) immediately before navigation, so no path — child links,
 * sitemap seeds, PDF→HTML chasing, pagination, resume/recovery, stale queue
 * entries — can put a cross-context URL on the network.
 *
 * Non-negotiable: a cross-context rejection can never be overridden by a high
 * link score. Scoring runs only for URLs this gate has already authorized.
 */
import { CrawlContext, PageClass } from "@clg/shared";
import { classifyUrl, type ClassifyInput, type UrlClassification } from "./urlClassifier.js";

export interface FetchDecision {
  /** May this URL be fetched under the active crawl context? */
  allowed: boolean;
  /** True when refused specifically because the page belongs to the OTHER context. */
  crossContext: boolean;
  /** Human-readable why (persisted + logged for auditability). */
  reason: string;
}

// Page classes each context may fetch. Discovery-support classes (navigation,
// unknown, listings of the context's own targets) are fetchable but are NOT
// final results — that separation is enforced by the validation engine.
const ALLOWED: Record<CrawlContext, ReadonlySet<PageClass>> = {
  [CrawlContext.ELIGIBILITY]: new Set<PageClass>([
    PageClass.COURSE_PAGE,
    PageClass.COURSE_LISTING,
    PageClass.ELIGIBILITY_PAGE,
    PageClass.ADMISSIONS_PAGE,
    PageClass.INTERNATIONAL_ADMISSIONS_PAGE,
    PageClass.NAVIGATION_PAGE,
    PageClass.UNKNOWN,
  ]),
  [CrawlContext.SCHOLARSHIP]: new Set<PageClass>([
    PageClass.SCHOLARSHIP_PAGE,
    PageClass.SCHOLARSHIP_LISTING,
    PageClass.FUNDING_PAGE,
    PageClass.NAVIGATION_PAGE,
    PageClass.UNKNOWN,
  ]),
};

// Page classes that belong to the OTHER context — refusing these is what the
// whole isolation architecture exists for, so they are named explicitly rather
// than derived, and recorded as REJECTED_CROSS_CONTEXT.
const CROSS_CONTEXT: Record<CrawlContext, ReadonlySet<PageClass>> = {
  [CrawlContext.ELIGIBILITY]: new Set<PageClass>([
    PageClass.SCHOLARSHIP_PAGE,
    PageClass.SCHOLARSHIP_LISTING,
    PageClass.FUNDING_PAGE,
  ]),
  [CrawlContext.SCHOLARSHIP]: new Set<PageClass>([
    PageClass.COURSE_PAGE,
    PageClass.COURSE_LISTING,
    PageClass.ELIGIBILITY_PAGE,
    PageClass.ADMISSIONS_PAGE,
    PageClass.INTERNATIONAL_ADMISSIONS_PAGE,
  ]),
};

/** Authorize (or refuse) fetching a page of the given class under a context. */
export function authorizeFetch(pageClass: PageClass, context: CrawlContext): FetchDecision {
  if (ALLOWED[context].has(pageClass)) {
    return { allowed: true, crossContext: false, reason: `${pageClass} authorized in ${context} crawl` };
  }
  if (CROSS_CONTEXT[context].has(pageClass)) {
    return {
      allowed: false,
      crossContext: true,
      reason: `${pageClass} belongs to the ${context === CrawlContext.ELIGIBILITY ? "SCHOLARSHIP" : "ELIGIBILITY"} context — rejected before fetch in ${context} crawl`,
    };
  }
  // DOCUMENT / IRRELEVANT: never fetched in any context.
  return { allowed: false, crossContext: false, reason: `${pageClass} is never fetched` };
}

export interface GateResult {
  classification: UrlClassification;
  decision: FetchDecision;
}

/** One-call gate: classify a discovered URL, then authorize it for the active
 *  context. Every enqueue point (child links, sitemap, PDF→HTML chase, resume
 *  frontier, pagination) must pass through this before the URL can be queued. */
export function gateUrl(input: ClassifyInput, context: CrawlContext): GateResult {
  const classification = classifyUrl(input);
  return { classification, decision: authorizeFetch(classification.pageClass, context) };
}

/** Marker used when the defensive pre-navigation check blocks a queued request
 *  (stale/recovered/foreign jobs). failedRequestHandler recognizes it and
 *  records REJECTED_CROSS_CONTEXT instead of BROKEN_LINK. */
export const CROSS_CONTEXT_FETCH_BLOCKED = "CROSS_CONTEXT_FETCH_BLOCKED";
