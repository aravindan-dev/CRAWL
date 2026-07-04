/**
 * PRE-FETCH URL classification — "what kind of page does this URL appear to
 * represent?" — decided deterministically from the strongest information
 * available BEFORE any network request: normalized URL path + structure, anchor
 * text, parent URL, the editable keyword vocabulary, and the same course/
 * scholarship URL patterns the exporters already trust (courseUrl.ts,
 * scholarship filters). Never an LLM, never a fetch.
 *
 * Classification is deliberately SEPARATE from link SCORING:
 *   - scoring answers "how relevant is this URL?" (linkScorer.ts)
 *   - classification answers "what kind of page is this?"
 *   - authorization answers "may this kind of page be fetched in the current
 *     crawl context?" (crawlAuthorization.ts)
 * A high score can never override a cross-context rejection.
 */
import { PageClass, getKeywords, keywordsToRegex, isPdfUrl, isDroppedFileType, SCH_CONTAINER_END } from "@clg/shared";
import { isRealCourse } from "../export/courseUrl.js";
import { filterLink } from "./linkFilters.js";

const KW = getKeywords();
const ELIG_RE = keywordsToRegex(KW.eligibility);
const INTL_RE = keywordsToRegex(KW.international);
const SCH_RE = keywordsToRegex(KW.scholarship);

// --- Scholarship-side patterns -------------------------------------------------
// Path-scoped: a URL LIVING under a scholarship/funding section belongs to the
// scholarship context even when a segment says "eligibility" (a scholarship's own
// eligibility tab is scholarship content, not course-admissions content).
const SCH_PATH = /\/(scholarships?|scholarships?-grants|find-scholarship|bursar(?:y|ies)|fellowships?|studentships?|financial[-_]?aid|financial[-_]?assistance|fee[-_]?waivers?)(\/|$|\.)/i;
const FUNDING_PATH = /\/(funding|fees[-_]?and[-_]?funding|cost[-_]?and[-_]?funding|financial[-_]?support|ways[-_]?to[-_]?pay|grants?)(\/|$|\.)/i;
// Listing-ish signals beyond the shared container-end rule (search/finder pages).
const SCH_FINDER = /scholarship[-_]?(search|finder|listing|database|dashboard)|search[-_]?scholarships?/i;

// --- Course-side patterns -------------------------------------------------------
// The course CATALOG path — same anchor the course exporter uses (recheck.ts).
const COURSE_CATALOG = /\/(courses?|programmes?|programs?|degrees?)(\/|$|\.)/i;
// Degree-flavoured slugs outside a catalog path (…/study/bachelor-of-nursing).
const DEGREE_SLUG = /(bachelor[-_]?of|master[-_]?of|doctor[-_]?of|diploma[-_]?of|[-_](bsc|beng|bba|llb|msc|meng|mba|llm)(\b|[-_.]))/i;
// Course/programme FINDER or directory pages.
const COURSE_FINDER = /(course|program(?:me)?|degree)[-_]?(finder|search|index|list(?:ing)?s?|directory|catalogu?e?)|find[-_]?(a[-_]?|your[-_]?)?(course|program(?:me)?|degree)|\ba[-_]?(to[-_]?)?z\b/i;

// --- Eligibility / admissions patterns ------------------------------------------
// ENTRY requirements = what you need to GET IN. Mirrors linkScorer's structural
// eligibility signal so scoring and classification agree on the vocabulary.
const STRUCT_ELIG = /(^|[\/\-_ ])(entry[\s\-_]?requirements?|entry[\s\-_]?criteri[a-z]*|entry[\s\-_]?profile|eligibility|admission[\s\-_]?requirements?|academic[\s\-_]?requirements?|qualification[\s\-_]?requirements?)([\/\-_. ]|$)/i;
const ADMISSIONS_PATH = /(^|[\/\-_ ])(admissions?|how[\s\-_]?to[\s\-_]?apply|apply)([\/\-_. ]|$)/i;
const INTL_PATH = /(^|[\/\-_ ])(international|overseas)([\/\-_. ]|$)/i;
// Anchor-text-only eligibility signals ("Check eligibility", "Entry requirements").
const ELIG_ANCHOR_TEXT = /check[\s\-_]?(your[\s\-_]?)?eligibility|eligibility[\s\-_]?criteria|entry[\s\-_]?requirements?|admission[\s\-_]?requirements?|how[\s\-_]?to[\s\-_]?apply/i;

// --- Navigation ------------------------------------------------------------------
const NAV_PATH = /(^|\/)(study|undergraduate|postgraduate|graduate|faculties|faculty|schools?|departments?|academics?|colleges?|about|home)(\/|$|\.)/i;

export interface ClassifyInput {
  url: string;
  /** Visible text of the <a> that referenced this URL, when known. */
  anchorText?: string;
  /** The page the link was found on (context clue only, never authoritative). */
  parentUrl?: string;
}

export interface UrlClassification {
  pageClass: PageClass;
  /** Human-readable why (for logs / the Review-links UI). */
  reason: string;
}

/**
 * Classify what kind of page a URL appears to represent, BEFORE fetching it.
 * Deterministic and lightweight (regex over URL + anchor text). Precedence:
 * documents → hard-filtered → scholarship path-scope → course catalog →
 * eligibility/admissions → navigation → unknown.
 */
export function classifyUrl(input: ClassifyInput): UrlClassification {
  const raw = (input.url ?? "").trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { pageClass: PageClass.IRRELEVANT, reason: "malformed URL" };
  }
  const path = u.pathname.toLowerCase();
  const low = raw.toLowerCase();
  const anchor = (input.anchorText ?? "").trim().toLowerCase();

  // 1) Documents: PDFs are recorded (PDF_DEFERRED) but never fetched; other
  //    binary types are dropped outright.
  if (isPdfUrl(raw) || isDroppedFileType(raw)) {
    return { pageClass: PageClass.DOCUMENT, reason: "document/binary file" };
  }

  // 2) Hard-filtered paths (login/news/social/…): never relevant to any context.
  const f = filterLink(raw);
  if (f.rejected) return { pageClass: PageClass.IRRELEVANT, reason: `filtered (${f.reason ?? "path"})` };

  // 3) SCHOLARSHIP scope — decided from the URL PATH first (authoritative): a
  //    page under /scholarships/... is scholarship content even when a segment
  //    or the anchor text says "eligibility".
  if (SCH_PATH.test(path)) {
    if (SCH_CONTAINER_END.test(path) || SCH_FINDER.test(low)) {
      return { pageClass: PageClass.SCHOLARSHIP_LISTING, reason: "scholarship listing/finder path" };
    }
    return { pageClass: PageClass.SCHOLARSHIP_PAGE, reason: "individual scholarship path" };
  }
  if (FUNDING_PATH.test(path)) {
    return { pageClass: PageClass.FUNDING_PAGE, reason: "funding/financial-aid path" };
  }

  // 4) COURSE scope — catalog path, degree slug, or a course finder/directory;
  //    the exporter's own individual-course test (isRealCourse) splits page vs
  //    listing.
  if (COURSE_CATALOG.test(path) || DEGREE_SLUG.test(path) || COURSE_FINDER.test(low)) {
    if (COURSE_FINDER.test(low) || !isRealCourse(low)) {
      return { pageClass: PageClass.COURSE_LISTING, reason: "course catalog/listing path" };
    }
    return { pageClass: PageClass.COURSE_PAGE, reason: "individual course/programme path" };
  }

  // 5) ELIGIBILITY / ADMISSIONS scope. International admissions is the most
  //    specific; then dedicated entry-requirements/eligibility pages; then
  //    general admissions (the eligibility vocabulary also contains "admission",
  //    so the STRONG entry-requirements signal is checked before the general
  //    admissions bucket). Anchor text counts here — "Check eligibility" on an
  //    opaque URL is still an eligibility link.
  const hay = `${path} ${anchor}`;
  const isIntl = INTL_PATH.test(path) || INTL_RE.test(hay);
  const isEligStrong = STRUCT_ELIG.test(hay) || ELIG_ANCHOR_TEXT.test(anchor);
  const isAdmissions = ADMISSIONS_PATH.test(hay);
  const isEligWeak = ELIG_RE.test(hay);
  if (isIntl && (isEligStrong || isAdmissions || isEligWeak)) {
    return { pageClass: PageClass.INTERNATIONAL_ADMISSIONS_PAGE, reason: "international admissions/entry-requirements" };
  }
  if (isEligStrong) return { pageClass: PageClass.ELIGIBILITY_PAGE, reason: "eligibility/entry-requirements signals" };
  if (isAdmissions) return { pageClass: PageClass.ADMISSIONS_PAGE, reason: "admissions/how-to-apply signals" };
  if (isEligWeak) return { pageClass: PageClass.ELIGIBILITY_PAGE, reason: "eligibility vocabulary signals" };

  // 6) Scholarship signals OUTSIDE a scholarship path (anchor text like
  //    "Scholarships and funding" on an opaque URL). Path scopes above already
  //    claimed course/eligibility URLs, so this cannot misfile a course page
  //    that merely mentions scholarships in its anchor.
  if (SCH_RE.test(hay)) {
    if (SCH_CONTAINER_END.test(path) || SCH_FINDER.test(low)) {
      return { pageClass: PageClass.SCHOLARSHIP_LISTING, reason: "scholarship listing signals" };
    }
    return { pageClass: PageClass.SCHOLARSHIP_PAGE, reason: "scholarship signals" };
  }

  // 7) Generic navigation (study/faculties/departments/… or the site root).
  if (path === "/" || path === "" || NAV_PATH.test(path)) {
    return { pageClass: PageClass.NAVIGATION_PAGE, reason: "navigation section" };
  }

  return { pageClass: PageClass.UNKNOWN, reason: "no classification signals" };
}
