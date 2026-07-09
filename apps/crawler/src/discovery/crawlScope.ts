/**
 * CATALOG-DRIVEN CRAWL SCOPE (the time-complexity win).
 *
 * The deliverable is the set of course / eligibility / scholarship pages. Those
 * are enumerated DIRECTLY by two cheap sources that run before any graph crawl:
 *   - the sitemap census (the authoritative course inventory), and
 *   - the catalogue / finder inventory probe.
 *
 * So there is no need to breadth-first crawl the WHOLE site graph to "discover"
 * courses — that visits tens of thousands of nav / news / staff / store /
 * study-plan pages that yield zero targets (observed live: ~18k pages crawled to
 * surface ~600 courses; the extra ~17k were in branches like /studyplan, /store,
 * /research, /current-students, /tag, /__data with 0 validated targets between
 * them). This module decides, for a discovered child link, whether it is worth
 * FETCHING: only target candidates, target listings/finders, and course-section
 * navigation hubs are followed. Everything else is recorded for audit but never
 * fetched.
 *
 * Coverage is preserved by construction:
 *   - the sitemap already seeds every course-catalogue URL directly;
 *   - every listing / finder / hub that CONTAINS course links is still crawled,
 *     and the course links it yields are target candidates (always followed);
 *   - EXTRACT-tier candidates are never scope-pruned.
 * The only thing dropped is generic pages that don't lead to the deliverable.
 *
 * Pure + unit-testable: no I/O, no crawler state.
 */
import { PageClass } from "@clg/shared";
import type { LinkDisposition } from "./linkScorer.js";

/** Page classes that ARE the deliverable (or directly enumerate it). Always
 *  followed regardless of relevance score. */
const TARGET_CLASSES: ReadonlySet<string> = new Set<string>([
  PageClass.COURSE_PAGE,
  PageClass.COURSE_LISTING, // course index / directory / finder — contains course links
  PageClass.ELIGIBILITY_PAGE,
  PageClass.ADMISSIONS_PAGE,
  PageClass.INTERNATIONAL_ADMISSIONS_PAGE,
  PageClass.SCHOLARSHIP_PAGE,
  PageClass.SCHOLARSHIP_LISTING, // scholarship index / finder
  PageClass.FUNDING_PAGE,
]);

/**
 * Navigation-hub path segments that PLAUSIBLY link to the deliverable and are
 * therefore worth expanding once: course/programme/degree sections, the study /
 * find-courses / faculty / school / department hubs, international & admissions
 * sections, the handbook/catalogue, and the scholarship/funding sections.
 *
 * Deliberately does NOT include generic sections that never lead to the
 * deliverable — /about, /research, /news, /our-university, /current-students,
 * /staff, /alumni, /store, /studyplan — those are where the old exhaustive crawl
 * burned its time for zero course/scholarship yield.
 */
const HUB_PATH =
  /(^|\/)(courses?|programmes?|programs?|degrees?|study|find[-_]?(a[-_]?)?courses?|coursefinder|course[-_]?finder|faculties|faculty|schools?|departments?|colleges?|international|overseas|admissions?|apply|entry[-_]?requirements?|how[-_]?to[-_]?apply|handbook|catalog(ue)?|scholarships?|funding|fees[-_]?and[-_]?funding|financial[-_]?aid|bursar(y|ies)|fellowships?)(\/|$|\?|\.)/i;

export interface ScopeInput {
  url: string;
  pageClass: PageClass;
  disposition: LinkDisposition;
  /** Depth of the CHILD link (parent depth + 1). */
  depth: number;
  /** When false, catalog-driven scoping is off — follow anything that scored. */
  catalogDriven: boolean;
}

/**
 * Should this discovered child link be FETCHED (vs. recorded-only)? In
 * catalog-driven mode, only target candidates, target listings/finders, and
 * course-section hubs are followed. The entry page's own immediate links
 * (depth ≤ 1) are always explored once so no top-level section is missed.
 */
export function shouldFetchForDiscovery(input: ScopeInput): boolean {
  // Exhaustive mode: preserve the old behaviour (follow anything that passed the
  // score gate) so a misbehaving site can fall back with one env flag.
  if (!input.catalogDriven) return true;
  // Real target candidate (course/eligibility/scholarship-relevant, score ≥ min).
  if (input.disposition === "EXTRACT") return true;
  // A page whose CLASS is the deliverable or a listing/finder that enumerates it.
  if (TARGET_CLASSES.has(input.pageClass)) return true;
  // Always explore the entry page's immediate navigation once (bounded: it's one
  // page's worth of top-nav/footer links) so every top-level section is reachable
  // even when its hub path is non-obvious.
  if (input.depth <= 1) return true;
  // A navigation hub that plausibly links to the deliverable.
  try {
    if (HUB_PATH.test(new URL(input.url).pathname)) return true;
  } catch {
    /* malformed URL — not fetchable anyway */
  }
  // Generic low-value page — the sitemap + catalogue already cover the
  // deliverable, so fetching this would only burn time. Record-only.
  return false;
}
