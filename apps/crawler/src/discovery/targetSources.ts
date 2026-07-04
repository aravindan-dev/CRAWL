/**
 * TARGET-SOURCE DISCOVERY (redesign Step 4 — "find the target source first").
 *
 * Before broad graph-crawling, we want the pages that ENUMERATE targets directly:
 *   - ELIGIBILITY  → course catalogues / course & degree finders / A–Z course lists
 *   - SCHOLARSHIP  → scholarship directories / funding hubs / scholarship finders
 *
 * This module only GENERATES the likely URLs (pure, deterministic, unit-testable).
 * The crawler HTTP-probes them cheaply (Step 3) and seeds the ones that actually
 * resolve at top priority, so hundreds of target URLs can be pulled from one
 * inventory page instead of being rediscovered by clicking through nav pages.
 *
 * Generated URLs are NOT trusted blindly: every one still passes classify →
 * authorize → filter before it can enter the frontier, exactly like any other
 * discovered link, so context isolation is preserved.
 */
import { CrawlContext, registrableDomain } from "@clg/shared";

// Academic subdomains that commonly host a SEPARATE course catalogue / handbook.
const ACADEMIC_SUBS = ["", "study.", "courses.", "handbook.", "programmes.", "catalogue.", "catalog."];

// The catalogue "roots" worth probing on those academic subdomains (the main
// site gets the full path repertoire below; subdomains only their entry points).
const ELIGIBILITY_CORE = ["/courses", "/course-search", "/programmes", "/programs", "/degrees", "/study", "/course-finder"];

const ELIGIBILITY_PATHS = [
  "/courses",
  "/courses/",
  "/course-search",
  "/courses/search",
  "/study/courses",
  "/programmes",
  "/programs",
  "/degrees",
  "/find-a-course",
  "/find-a-programme",
  "/course-finder",
  "/programme-finder",
  "/degree-finder",
  "/study",
  "/study-options",
  "/undergraduate",
  "/postgraduate",
  "/course-index",
  "/a-z",
  "/courses/a-z",
];

const SCHOLARSHIP_PATHS = [
  "/scholarships",
  "/scholarships/",
  "/scholarship-search",
  "/scholarships/search",
  "/find-a-scholarship",
  "/scholarship-finder",
  "/scholarships-and-bursaries",
  "/bursaries",
  "/funding",
  "/fees-and-funding",
  "/financial-aid",
  "/financial-support",
  "/scholarships-and-funding",
];

/**
 * Likely target-source URLs for a base site under one crawl context. Origins
 * cover the base host plus common academic subdomains; paths cover catalogue /
 * finder / directory conventions. De-duplicated, capped, and deterministic.
 */
export function candidateTargetSources(baseUrl: string, context: CrawlContext, cap = 80): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const reg = registrableDomain(base.hostname);
  const paths = context === CrawlContext.SCHOLARSHIP ? SCHOLARSHIP_PATHS : ELIGIBILITY_PATHS;

  const out = new Set<string>();
  const add = (u: string) => {
    if (out.size < cap) out.add(u);
  };

  // 1) The MAIN site gets the full path repertoire — course/scholarship finders
  //    and directories most often live on www/base.
  for (const p of paths) add(`${base.origin}${p}`);

  // 2) A SEPARATE course catalogue commonly sits on an academic subdomain
  //    (study./courses./handbook.). Probe those roots only. Scholarship
  //    inventories live on the main site, so skip catalogue subdomains for it
  //    (wasted DNS on hosts that don't exist).
  if (context !== CrawlContext.SCHOLARSHIP) {
    for (const s of ACADEMIC_SUBS) {
      const origin = `https://${s}${reg}`;
      if (origin === base.origin) continue;
      for (const p of ELIGIBILITY_CORE) add(`${origin}${p}`);
    }
  }
  return [...out];
}
