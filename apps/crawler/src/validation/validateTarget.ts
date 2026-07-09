/**
 * TARGET VALIDATION — the context-aware half of the validation engine.
 *
 * classifyPage (validatePage.ts) still answers the page-health question
 * ("did a real page load, what shape is it?"). THIS module answers the target
 * question, which is context-specific and two-staged:
 *
 *  ELIGIBILITY crawl:
 *    1. Is this page ONE specific course/programme? (course identity FIRST)
 *    2. Does it carry course-level eligibility evidence (entry requirements,
 *       grades, English requirements — inline, in an accordion/tab, or at a
 *       same-page anchor)?
 *    Only when BOTH hold is the page a validated target — and the target URL is
 *    the MAIN course page (anchors stay secondary metadata).
 *
 *  SCHOLARSHIP crawl:
 *    1. Is this page one specific scholarship (not a listing/blog/fees page)?
 *    2. Does the page text confirm scholarship content?
 *
 * Everything else is DISCOVERY_ONLY (useful for finding links, never exported)
 * or REJECTED. Decisions are explainable: outcome + reasons + evidence +
 * confidence, so the pipeline is debuggable and auditable.
 */
import { CrawlContext, PageClass, getKeywords, keywordsToRegex, rejectScholarship, scholarshipSubstance, isDomesticText } from "@clg/shared";

const KW = getKeywords();
const EVIDENCE_RE = keywordsToRegex(KW.evidence); // page-content proof of entry requirements
const SCHOLARSHIP_RE = keywordsToRegex(KW.scholarship); // funding/scholarship content signals
// Global (all-matches) variant of the same vocabulary, used to require more than
// a single stray keyword hit before an individual scholarship page is accepted
// (a lone match is too easily a nav/breadcrumb mention, not real page content).
const SCHOLARSHIP_RE_G = new RegExp(SCHOLARSHIP_RE.source, "gi");

// AUDIENCE (Settings → "Find eligibility for…"): "international" (default) never
// validates a page whose own text scopes it to domestic/home students only —
// this product exists to find INTERNATIONAL-student pages. "all" restores the
// old behavior (domestic + international). Restart the crawler to apply.
const AUDIENCE = (process.env.AUDIENCE ?? "international").toLowerCase() === "all" ? "all" : "international";

// Bare category/facet labels seen as the WHOLE title of a scholarship finder's
// filter tabs (e.g. sydney.edu.au's …/domestic/postgraduate-research/faculty.html
// and …/general.html) — never a real scholarship's name. Exact-match only (a
// real scholarship whose name merely CONTAINS one of these words, e.g. "Faculty
// of Science Research Scholarship", is unaffected).
const GENERIC_SCHOLARSHIP_TITLES = new Set([
  "faculty", "faculties", "general", "domestic", "international", "undergraduate", "postgraduate",
  "postgraduate research", "undergraduate research", "research", "equity", "accommodation", "foundation",
  "commencing", "continuing", "scholarships", "scholarship", "find a scholarship",
]);

// Course-identity CONTENT signals (spec: title, award, duration, intake,
// campus, modules/curriculum/structure — never just the word "course").
const AWARD_RE = /\b(bsc|ba|beng|bba|llb|bcom|bfa|bed|msc|ma|meng|mba|llm|mphil|phd|bachelor|master|doctor(?:ate)?|diploma|associate degree|graduate certificate|foundation (?:year|programme|program))\b/i;
const STRUCTURE_RE = /\b(modules?|curriculum|course structure|programme structure|program structure|units? of study|subjects? you(?:'|’)?ll study|what you(?:'|’)?ll (?:study|learn)|course overview|programme overview)\b/i;
const DETAIL_RE = /\b(duration|intakes?|start dates?|commencement|study mode|full[- ]time|part[- ]time|campus|cricos|ucas code|course code|programme code|atar|credit points)\b/i;

/** Short proof snippet around the first match (shown in the feed / logs). */
function snippetAround(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m || m.index === undefined) return "";
  return text.slice(Math.max(0, m.index - 50), m.index + 90).replace(/\s+/g, " ").trim();
}

export const TargetOutcome = {
  /** Satisfies the crawl's target requirements — exportable. */
  VALIDATED_TARGET: "VALIDATED_TARGET",
  /** Fetched legitimately to find links, but never a final result. */
  DISCOVERY_ONLY: "DISCOVERY_ONLY",
  /** Must not be used further (wrong context after redirect, irrelevant…). */
  REJECTED: "REJECTED",
} as const;
export type TargetOutcome = (typeof TargetOutcome)[keyof typeof TargetOutcome];

export interface TargetValidationInput {
  context: CrawlContext;
  /** Post-redirect final URL (re-classified — redirects can cross contexts). */
  finalUrl: string;
  /** Classification of the FINAL url. */
  pageClass: PageClass;
  title: string;
  /** Visible page text (already extracted — validation costs no extra fetch). */
  text: string;
  /** An entry-requirements section/tab/modal anchor exists on the page. */
  hasEntryAnchor: boolean;
  /** How many course facts (duration/intakes/fees/campus/…) were extracted. */
  factCount: number;
}

export interface TargetValidation {
  outcome: TargetOutcome;
  /** What kind of target this page was accepted as (null unless validated). */
  targetType: "COURSE" | "SCHOLARSHIP" | null;
  /** Stage-1 verdict: does the page prove ONE specific course/programme? */
  courseIdentity: boolean;
  /** Proof snippet (entry-requirement text, anchor id, scholarship text). */
  evidence: string;
  /** Explainable decision trail, most significant first. */
  reasons: string[];
  confidence: number; // 0..1, coarse + deterministic
}

const decide = (
  outcome: TargetOutcome,
  targetType: TargetValidation["targetType"],
  courseIdentity: boolean,
  evidence: string,
  reasons: string[],
  confidence: number,
): TargetValidation => ({ outcome, targetType, courseIdentity, evidence, reasons, confidence });

export function validateTarget(input: TargetValidationInput): TargetValidation {
  if (!input.text || input.text.trim().length === 0) {
    return decide(TargetOutcome.REJECTED, null, false, "", ["no page text"], 0);
  }
  if (input.context === CrawlContext.ELIGIBILITY) return validateCourseTarget(input);
  return validateScholarshipTarget(input, input.title);
}

// --- ELIGIBILITY: individual course page with course-level evidence -------------
function validateCourseTarget(input: TargetValidationInput): TargetValidation {
  const { pageClass, title, text, hasEntryAnchor, factCount } = input;

  // A scholarship-classed destination inside an eligibility crawl (possible only
  // via redirect — discovery already rejects these pre-fetch) is never usable.
  if (
    pageClass === PageClass.SCHOLARSHIP_PAGE ||
    pageClass === PageClass.SCHOLARSHIP_LISTING ||
    pageClass === PageClass.FUNDING_PAGE
  ) {
    return decide(TargetOutcome.REJECTED, null, false, "", ["scholarship page in eligibility context"], 0);
  }

  // AUDIENCE: a page whose own text scopes it to domestic/home students only is
  // never an international-eligibility target (Settings → "Find eligibility
  // for…"). Checked before course identity so it can't be masked by an
  // otherwise-convincing award/structure match.
  if (AUDIENCE !== "all" && isDomesticText(text)) {
    return decide(TargetOutcome.DISCOVERY_ONLY, null, false, "", ["domestic-only content — international students only"], 0.2);
  }

  // STAGE 1 — course identity. URL class says "individual course page"; the
  // CONTENT must corroborate with award/structure/detail signals so a generic
  // page that merely sits under /courses/ can't pass.
  if (pageClass === PageClass.COURSE_PAGE) {
    const award = AWARD_RE.test(title) || AWARD_RE.test(text.slice(0, 600));
    const structure = STRUCTURE_RE.test(text);
    const detail = DETAIL_RE.test(text) || factCount >= 1;
    const identitySignals = [award, structure, detail].filter(Boolean).length;
    const courseIdentity = award ? identitySignals >= 1 : identitySignals >= 2;
    if (!courseIdentity) {
      return decide(TargetOutcome.DISCOVERY_ONLY, null, false, "", [
        "no course identity",
        "course-like URL but the content shows no award/structure/detail signals",
      ], 0.2);
    }

    // STAGE 2 — course-level eligibility evidence, on THIS page (inline text,
    // accordion/tab content, or a same-page entry-requirements anchor).
    if (EVIDENCE_RE.test(text)) {
      return decide(
        TargetOutcome.VALIDATED_TARGET,
        "COURSE",
        true,
        snippetAround(text, EVIDENCE_RE),
        ["individual course page", "course-level eligibility evidence in text"],
        0.9,
      );
    }
    if (hasEntryAnchor) {
      // The requirements live in a modal/tab (not in the flat text) — the
      // anchor's existence proves the section; it stays SECONDARY metadata.
      return decide(
        TargetOutcome.VALIDATED_TARGET,
        "COURSE",
        true,
        "entry-requirements section present (same-page anchor)",
        ["individual course page", "entry-requirements section detected via anchor"],
        0.7,
      );
    }
    return decide(TargetOutcome.DISCOVERY_ONLY, null, true, "", [
      "no course-level eligibility evidence",
      "individual course page without entry-requirement content",
    ], 0.4);
  }

  // General pages: legitimate DISCOVERY surface, never final course results —
  // even when they contain eligibility keywords (spec: a general admissions or
  // university-wide international page is not a course eligibility target).
  const discoveryReason: Partial<Record<PageClass, string>> = {
    [PageClass.COURSE_LISTING]: "course listing page — discovery only",
    [PageClass.ELIGIBILITY_PAGE]: "general eligibility page — discovery only, not an individual course",
    [PageClass.ADMISSIONS_PAGE]: "general admissions page — discovery only, not an individual course",
    [PageClass.INTERNATIONAL_ADMISSIONS_PAGE]: "general international admissions page — discovery only, not an individual course",
    [PageClass.NAVIGATION_PAGE]: "navigation page — discovery only",
    [PageClass.UNKNOWN]: "unclassified page — discovery only",
  };
  const reason = discoveryReason[input.pageClass];
  if (reason) return decide(TargetOutcome.DISCOVERY_ONLY, null, false, "", [reason], 0.3);

  return decide(TargetOutcome.REJECTED, null, false, "", ["irrelevant content"], 0);
}

// --- SCHOLARSHIP: individual scholarship page with scholarship evidence ---------
function validateScholarshipTarget(input: TargetValidationInput, title: string): TargetValidation {
  const { pageClass, text, finalUrl } = input;

  // Course/eligibility-classed destinations are the OTHER context (again: only
  // reachable via redirect — discovery rejects them before fetch).
  if (
    pageClass === PageClass.COURSE_PAGE ||
    pageClass === PageClass.COURSE_LISTING ||
    pageClass === PageClass.ELIGIBILITY_PAGE ||
    pageClass === PageClass.ADMISSIONS_PAGE ||
    pageClass === PageClass.INTERNATIONAL_ADMISSIONS_PAGE
  ) {
    return decide(TargetOutcome.REJECTED, null, false, "", ["eligibility or course page in scholarship context"], 0);
  }

  // AUDIENCE: a page whose own text scopes it to domestic/home students only is
  // never an international-scholarship target (Settings → "Find eligibility
  // for…"). Checked before the scholarship-page branch below.
  if (AUDIENCE !== "all" && isDomesticText(text)) {
    return decide(TargetOutcome.DISCOVERY_ONLY, null, false, "", ["domestic-only content — international students only"], 0.2);
  }

  if (pageClass === PageClass.SCHOLARSHIP_PAGE) {
    // Precision filters shared with the exporter: blog articles, fee pages,
    // listing containers and login gates are never scholarship records.
    const precision = rejectScholarship(finalUrl, "");
    if (precision) {
      return decide(TargetOutcome.DISCOVERY_ONLY, null, false, "", [`not an individual scholarship (${precision})`], 0.2);
    }
    // A bare category/filter-tab label ("Faculty", "General", …) as the WHOLE
    // title is a finder facet, never a named scholarship — even though the page
    // carries scholarship keywords (every page under the finder does, via nav).
    if (GENERIC_SCHOLARSHIP_TITLES.has(title.trim().toLowerCase())) {
      return decide(TargetOutcome.DISCOVERY_ONLY, null, false, "", ["category/filter page (generic title, not a named scholarship)"], 0.2);
    }
    // Require MORE THAN ONE scholarship-vocabulary hit in the text: a single
    // stray match is too easily a nav/breadcrumb/boilerplate mention (or, before
    // keywordsToRegex gained word-boundary guards, a false substring match) —
    // never real page content. A genuine scholarship page mentions scholarship
    // terms repeatedly (title, body, "how to apply for this scholarship", …).
    const hits = (text.match(SCHOLARSHIP_RE_G) ?? []).length;
    if (hits >= 2 && (SCHOLARSHIP_RE.test(finalUrl.toLowerCase()) || SCHOLARSHIP_RE.test(title.toLowerCase()))) {
      // SUBSTANCE gate (sell §703): scholarship vocabulary alone isn't a record —
      // an individual scholarship page must also carry at least one CONCRETE
      // detail: a deadline, a monetary value/amount, eligibility/award criteria,
      // application requirements, OR an explicit international-student scope. A
      // stub/marketing page that only repeats "scholarship" is discovery, not a
      // target. This lifts scholarship precision without dropping real records
      // (genuine scholarship pages state a value, deadline or who may apply).
      if (!scholarshipSubstance(text)) {
        return decide(TargetOutcome.DISCOVERY_ONLY, null, false, "", [
          "scholarship page without substance (no deadline/amount/eligibility/international signal)",
        ], 0.3);
      }
      return decide(
        TargetOutcome.VALIDATED_TARGET,
        "SCHOLARSHIP",
        false,
        snippetAround(text, SCHOLARSHIP_RE),
        ["individual scholarship page", "scholarship evidence in text"],
        0.85,
      );
    }
    return decide(TargetOutcome.DISCOVERY_ONLY, null, false, "", ["scholarship-like URL without enough scholarship content"], 0.3);
  }

  if (pageClass === PageClass.SCHOLARSHIP_LISTING || pageClass === PageClass.FUNDING_PAGE) {
    return decide(TargetOutcome.DISCOVERY_ONLY, null, false, "", ["scholarship listing/funding page — discovery only"], 0.3);
  }
  if (pageClass === PageClass.NAVIGATION_PAGE || pageClass === PageClass.UNKNOWN) {
    return decide(TargetOutcome.DISCOVERY_ONLY, null, false, "", ["navigation page — discovery only"], 0.3);
  }
  return decide(TargetOutcome.REJECTED, null, false, "", ["irrelevant content"], 0);
}
