/**
 * AUTO DEEP DISCOVERY — the bounded "recover missing courses" decision.
 *
 * The coverage report already warns when an eligibility crawl validated far fewer
 * courses than the course surface it discovered (LOW_COVERAGE). This turns that
 * warning into ACTION: when the frontier drains at low coverage, re-seed the
 * course hubs (listings / finders / faculty / department pages) + any known-but-
 * unfetched course URLs, so courses hidden behind JS finders, pagination or a seed
 * cap are pulled in and validated. The SEEDING is I/O (DB query + push); this
 * module is the pure, unit-tested GATE that keeps it bounded and non-looping.
 *
 * V4 TRIGGERS:
 *  Case 1: validated === 0 — no eligibility found at all → deep discover.
 *  Case 2: discoveredLinksCount > 1000 or courseSurface > 300 — large university
 *          with potential hidden course pages → deep discover.
 *  Case 3: validated / courseSurface < maxRatio — low coverage → deep discover.
 *
 * Bounds: only fires for a course surface big enough to matter (`minSurface`
 * — waived for Case 1), only while the validated:surface ratio is below
 * `maxRatio`, and only up to `maxPasses` times per crawl — after which the
 * crawl finishes honestly.
 */
export interface DeepDiscoveryState {
  /** DEEP_DISCOVERY_MODE — feature on? */
  enabled: boolean;
  /** how many deep passes already ran this crawl. */
  passes: number;
  /** DEEP_DISCOVERY_MAX_PASSES. */
  maxPasses: number;
  /** distinct course-class URLs discovered (COURSE_PAGE + COURSE_LISTING). */
  courseSurface: number;
  /** validated course targets so far. */
  validated: number;
  /** total discovered links count (all classes) — V4 large-university trigger. */
  discoveredLinksCount?: number;
  /** ignore tiny sites where the ratio is noisy (default 30). */
  minSurface?: number;
  /** trigger below this validated:surface ratio (default 0.15). */
  maxRatio?: number;
}

export const DEFAULT_MIN_SURFACE = 30;
export const DEFAULT_MAX_RATIO = 0.15;

/** Should another bounded deep-discovery pass run now? Pure — no I/O. */
export function shouldDeepDiscover(s: DeepDiscoveryState): boolean {
  if (!s.enabled) return false;
  if (s.passes >= s.maxPasses) return false;

  // Case 1: Zero validated — no eligibility found at all. Trigger regardless
  // of surface size (even a small site that yielded nothing needs recovery).
  if (s.validated === 0) return true;

  // Case 2: Large university — lots of discovered links or a huge course
  // surface. These sites often hide courses behind JS finders / pagination.
  const discoveredLinks = s.discoveredLinksCount ?? 0;
  if (discoveredLinks > 1000 || s.courseSurface > 300) {
    const maxRatio = s.maxRatio ?? DEFAULT_MAX_RATIO;
    const ratio = s.courseSurface > 0 ? s.validated / s.courseSurface : 1;
    if (ratio < maxRatio) return true;
  }

  // Case 3: Low coverage ratio (original trigger) — only fires for sites
  // large enough that the ratio is meaningful.
  const minSurface = s.minSurface ?? DEFAULT_MIN_SURFACE;
  const maxRatio = s.maxRatio ?? DEFAULT_MAX_RATIO;
  if (s.courseSurface < minSurface) return false;
  const ratio = s.courseSurface > 0 ? s.validated / s.courseSurface : 1;
  return ratio < maxRatio;
}
