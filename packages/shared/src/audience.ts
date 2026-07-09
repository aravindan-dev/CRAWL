import { getKeywords, keywordsToRegex } from "./keywords.js";

/**
 * AUDIENCE SCOPE — this product exists to find INTERNATIONAL-student
 * eligibility/scholarship URLs (Settings → "Find eligibility for…", default
 * "international"). A page or URL segment that unambiguously scopes itself to
 * domestic/home applicants ONLY is never a deliverable in that mode, in either
 * crawl context (eligibility or scholarship) — checking it is wasted crawl
 * time and a false "validated" result.
 *
 * Two independent signals, both high-precision by design (false negatives —
 * missing a domestic page — are cheap; false positives — dropping a real
 * international page — are not):
 *  - `isDomesticPath` — the URL PATH itself names a domestic/home section
 *    (e.g. "/scholarships/domestic/...", "/home-students/..."). Cheap and
 *    pre-fetch, so it is the primary lever for not wasting crawl time.
 *  - `isDomesticText` — the editable `domesticExclude` keyword list (Settings
 *    → Keywords) matched in the page's own text. Post-fetch, defense in
 *    depth for sites that don't put "domestic" in the URL.
 */
const DOMESTIC_PATH_RE = /(^|[\/\-_])(domestic|home-students?|local-students?)([\/\-_.]|$)/i;

const DOMESTIC_TEXT_RE = keywordsToRegex(getKeywords().domesticExclude);

/** True when the URL PATH itself unambiguously scopes to domestic/home students. */
export function isDomesticPath(url: string): boolean {
  try {
    return DOMESTIC_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** True when the given text unambiguously scopes itself to domestic/home students. */
export function isDomesticText(text: string): boolean {
  return !!text && DOMESTIC_TEXT_RE.test(text);
}
