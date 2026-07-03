/**
 * COURSE-FACTS extraction engine (redesign §11) — extends the deliverable beyond
 * URLs: tuition fees, intakes, duration, application deadline, study mode, campus,
 * CRICOS code, English requirement, course benefits and an eligibility snippet.
 *
 * DESIGN: a deterministic extractor LADDER, evaluated per field in fixed order —
 *   1. JSON-LD (schema.org Course / EducationalOccupationalProgram) — structured,
 *      authoritative when present.
 *   2. Labeled-value regexes over the page's visible text ("Duration 3 years
 *      full-time", "CRICOS code: 012345A", "Indicative annual fee AUD $34,000").
 * First present source wins. All patterns and windows are FIXED constants, so an
 * unchanged page always extracts identical facts (determinism law), and the whole
 * pass is O(page text) time / O(1) space per page — it runs INLINE during the
 * crawl on text we already hold, adding zero extra fetches.
 */

export interface CourseFacts {
  tuition_fee_international?: string;
  duration?: string;
  intakes?: string;
  application_deadline?: string;
  study_mode?: string;
  campus?: string;
  cricos_code?: string;
  english_requirement?: string;
  benefits?: string;
  eligibility_snippet?: string;
}

/** Facts field order — the export columns are emitted in exactly this order. */
export const FACT_FIELDS: (keyof CourseFacts)[] = [
  "duration", "intakes", "tuition_fee_international", "application_deadline",
  "study_mode", "campus", "cricos_code", "english_requirement", "benefits", "eligibility_snippet",
];

// Analysis caps: bound the work per page so a pathological page can't stall the
// crawl. Facts live near the top of course pages; 120k chars is generous.
const MAX_TEXT = 120_000;
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Find `valueRe`'s first match within `window` chars after each `labelRe` hit. */
function near(text: string, labelRe: RegExp, valueRe: RegExp, window: number): string | undefined {
  const label = new RegExp(labelRe.source, labelRe.flags.includes("g") ? labelRe.flags : labelRe.flags + "g");
  for (const m of text.matchAll(label)) {
    const start = m.index! + m[0].length;
    const slice = text.slice(start, start + window);
    const v = valueRe.exec(slice);
    if (v) return clean(v[0]);
  }
  return undefined;
}

// A candidate section that is really the page's TAB-STRIP / NAV (e.g. CSU's
// "Career opportunities What you will study Costs Entry requirements How to Apply
// Save to compare…") — ≥3 known tab labels crammed into the first 120 chars means
// we matched the navigation, not the content. Skip it and try the next heading.
const NAV_LABELS =
  /(career opportunities|what you will study|entry requirements|how to apply|save to compare|key information|fees? and scholarships|costs|overview|why study)/gi;
function looksLikeNav(s: string): boolean {
  const head = s.slice(0, 120);
  const hits = head.match(NAV_LABELS);
  return (hits?.length ?? 0) >= 3;
}

/**
 * The text block (fixed length) following the first heading match whose content
 * is BOTH non-nav AND on-topic (`mustMatch`). Course pages repeat section labels
 * (tab strips, key-info boxes) before the real section — e.g. CSU's "Entry
 * requirements" appears 5×, and only the 3rd is followed by actual admission
 * content ("Selection rank: 65 … ATARs …"). Content validation finds that one.
 */
function sectionAfter(text: string, headingRe: RegExp, length: number, mustMatch: RegExp): string | undefined {
  const re = new RegExp(headingRe.source, headingRe.flags.includes("g") ? headingRe.flags : headingRe.flags + "g");
  for (const m of text.matchAll(re)) {
    const s = clean(text.slice(m.index! + m[0].length, m.index! + m[0].length + length));
    if (s.length < 40) continue; // heading with no content here
    if (looksLikeNav(s)) continue; // tab strip / menu — real section comes later
    if (!mustMatch.test(s)) continue; // off-topic block (fees box under a requirements label)
    return s;
  }
  return undefined;
}

// On-topic validators: what the section CONTENT must mention to count.
const ELIG_CONTENT = /(selection rank|atar\b|admission|qualif|year 12|high school|secondary|diploma|bachelor|degree|equivalent|prerequisite|assumed knowledge|ielts|english language|academic|entry score|gpa)/i;
const BENEFIT_CONTENT = /(career|graduate|work|industry|employ|role|opportunit|skill|profession|sector|lead)/i;

// ---- JSON-LD (ladder step 1) ---------------------------------------------------

const COURSE_TYPES = /^(Course|EducationalOccupationalProgram|Program)$/i;

/** Humanize an ISO-8601 duration (P3Y, P18M, P52W) — else return the raw string. */
function humanDuration(iso: string): string {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?/i.exec(iso.trim());
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return iso.trim();
  const parts: string[] = [];
  if (m[1]) parts.push(`${m[1]} year${m[1] === "1" ? "" : "s"}`);
  if (m[2]) parts.push(`${m[2]} month${m[2] === "1" ? "" : "s"}`);
  if (m[3]) parts.push(`${m[3]} week${m[3] === "1" ? "" : "s"}`);
  if (m[4]) parts.push(`${m[4]} day${m[4] === "1" ? "" : "s"}`);
  return parts.join(" ");
}

/** Walk every JSON-LD block for course-shaped objects and pull structured facts. */
function factsFromJsonLd(html: string): CourseFacts {
  const out: CourseFacts = {};
  const blocks = [...html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const types = ([] as unknown[]).concat(o["@type"] ?? []);
    if (types.some((t) => typeof t === "string" && COURSE_TYPES.test(t))) {
      if (!out.duration && typeof o.timeToComplete === "string") out.duration = humanDuration(o.timeToComplete);
      if (!out.study_mode && typeof o.educationalProgramMode === "string") out.study_mode = clean(o.educationalProgramMode);
      if (!out.application_deadline && typeof o.applicationDeadline === "string") out.application_deadline = clean(o.applicationDeadline);
      const starts = ([] as unknown[]).concat(o.startDate ?? []).filter((s): s is string => typeof s === "string");
      if (!out.intakes && starts.length) out.intakes = starts.slice(0, 6).map(clean).join("; ");
      const offers = ([] as unknown[]).concat(o.offers ?? []);
      for (const of_ of offers) {
        if (out.tuition_fee_international) break;
        if (of_ && typeof of_ === "object") {
          const ofo = of_ as Record<string, unknown>;
          const spec = (ofo.priceSpecification ?? {}) as Record<string, unknown>;
          const price = ofo.price ?? spec.price;
          if (price !== undefined && price !== null && String(price).trim()) {
            const cur = typeof ofo.priceCurrency === "string" ? ofo.priceCurrency : "";
            out.tuition_fee_international = clean(`${cur} ${String(price)}`);
          }
        }
      }
    }
    // Recurse into @graph / nested structures.
    for (const v of Object.values(o)) if (v && typeof v === "object") visit(v);
  };
  for (const b of blocks) {
    try { visit(JSON.parse(b[1]!)); } catch { /* malformed JSON-LD — skip block */ }
  }
  return out;
}

// ---- Labeled-value text patterns (ladder step 2) --------------------------------

// Handles "AUD 34,800", "$34,800", AND the combined "AUD $34,800" form.
const MONEY = /(?:AUD|USD|GBP|EUR|CAD|NZD|SGD|INR|A\$|US\$|NZ\$|C\$|S\$|£|€|\$)(?:\s?\$)?\s?[\d,]{3,}(?:\.\d\d)?(?:\s?(?:per|\/|p\.?a\.?|pa\b)\s?(?:year|annum|session|semester)?)?/i;
const DATE = /(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i;
const DUR_VALUE = /\d+(?:\.\d+)?\s*(?:year|month|week|semester|trimester|term)s?(?:\s*(?:full[- ]time|part[- ]time|equivalent))?/i;
const MONTH_OR_SESSION = /\b(january|february|march|april|may|june|july|august|september|october|november|december|semester\s*[12]|session\s*[123]|term\s*[1234]|trimester\s*[123]|spring|summer|autumn|fall|winter)\b/gi;

function factsFromText(text: string): CourseFacts {
  const out: CourseFacts = {};

  out.duration =
    near(text, /\b(duration|course length|length of course|study duration|program length)\b[:\s]*/i, DUR_VALUE, 120) ??
    /\d+(?:\.\d+)?\s*years?\s*(?:full[- ]time|part[- ]time)/i.exec(text)?.[0] ?? // "3 years full-time" anywhere
    undefined;
  if (out.duration) out.duration = clean(out.duration);

  out.tuition_fee_international =
    near(text, /\b(?:international(?:\s+student)?s?[^.\n]{0,60}?(?:fees?|tuition)|(?:fees?|tuition)[^.\n]{0,60}?international|indicative (?:annual )?fee|annual tuition fee|tuition fees?)\b[:\s]*/i, MONEY, 220) ?? undefined;

  // "Next session start: July 13, 2026" (CSU) is as authoritative as an "Intakes:"
  // label — both phrasings feed the same month scan.
  const intakeZone = near(
    text,
    /\b(intakes?|start dates?|commencement|commencing|starting|sessions? available|next session start|session starts?|entry points?)\b[:\s]*/i,
    /[\s\S]{1,180}/,
    200,
  );
  if (intakeZone) {
    const months = [...intakeZone.matchAll(MONTH_OR_SESSION)].map((m) => clean(m[0]));
    const uniq = [...new Set(months.map((m) => m.toLowerCase()))].slice(0, 6);
    if (uniq.length) out.intakes = uniq.map((m) => m.replace(/\b\w/g, (c) => c.toUpperCase())).join("; ");
  }

  out.application_deadline =
    near(text, /\b(application (?:deadline|closing date)s?|applications? closes?|apply by|closing date)\b[:\s]*/i, DATE, 140) ?? undefined;

  const modes = [...new Set([...text.matchAll(/\b(full[- ]time|part[- ]time|online|on[- ]campus|distance(?:\s+education)?|blended|mixed mode)\b/gi)].map((m) => m[0].toLowerCase().replace(/\s+/g, "-")))];
  if (modes.length) out.study_mode = modes.slice(0, 4).join("; ");

  const campus = near(text, /\b(campus(?:es)?|study locations?|available at|offered at|delivery locations?)\b[:\s]*/i, /[A-Z][A-Za-z'’-]+(?:[ ,&/]+[A-Z][A-Za-z'’-]+){0,6}/, 140);
  // Reject junk captures: a campus is a PLACE — never a sentence-opening pronoun,
  // demonstrative or verb ("These…", "Make a difference…", "Choose your…").
  if (
    campus &&
    !/^(these|this|that|those|the|our|your|all|please|view|see|find|more|other|make|choose|start|apply|learn|discover|explore|get|meet|join|study|take|become|enjoy|experience|you|we|it)\b/i.test(campus)
  ) {
    out.campus = campus;
  }

  const cricos = /\bCRICOS(?:\s*(?:course)?\s*code)?\s*[:#]?\s*(\d{5,7}[A-Z]?)\b/i.exec(text);
  if (cricos) out.cricos_code = cricos[1]!;

  const english =
    /\bIELTS[^.\n]{0,80}?\d(?:\.\d)?/i.exec(text)?.[0] ??
    /\bTOEFL[^.\n]{0,60}?\d{2,3}/i.exec(text)?.[0] ??
    /\bPTE[^.\n]{0,60}?\d{2}/i.exec(text)?.[0];
  if (english) out.english_requirement = clean(english);

  out.benefits = sectionAfter(text, /\b(career (?:opportunities|outcomes|prospects)|why study (?:with us\??|this course|this|with)|graduate outcomes|what you(?:'|’)?ll (?:learn|study)|course highlights)[:\s]*/i, 260, BENEFIT_CONTENT);
  out.eligibility_snippet = sectionAfter(text, /\b(entry requirements?|admission (?:criteria|requirements?)|academic (?:entry )?requirements?|eligibility criteria)\b[:\s]*/i, 320, ELIG_CONTENT);

  return out;
}

/**
 * Extract every available course fact from a page. JSON-LD wins per field; the
 * labeled-text ladder fills the gaps. Missing fields stay absent (never guessed).
 */
export function extractCourseFacts(visibleText: string, rawHtml: string): CourseFacts {
  const text = visibleText.slice(0, MAX_TEXT);
  const ld = factsFromJsonLd(rawHtml.slice(0, MAX_TEXT * 4));
  const tx = factsFromText(text);
  const out: CourseFacts = {};
  for (const f of FACT_FIELDS) {
    const v = ld[f] ?? tx[f];
    if (v) out[f] = v;
  }
  return out;
}
