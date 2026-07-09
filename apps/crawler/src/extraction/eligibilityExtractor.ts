/**
 * V4 ELIGIBILITY DETAILS EXTRACTOR — rule-based extraction of the 4 core
 * university eligibility fields from page text. No LLM, no AI — pure regex
 * over the visible text content of a validated eligibility page.
 *
 * Fields:
 *  1. english_requirement  — IELTS / TOEFL / PTE / Cambridge scores
 *  2. academic_requirement — GPA / grades / qualifications / A-levels
 *  3. country_requirement  — country-specific entry information
 *  4. application_requirement — deadlines / how to apply / documents needed
 *
 * These are formatted into a readable multiline string and written to the
 * DiscoveredLink.evidence field, so they're available in the export and the
 * validated-URLs feed without a schema change.
 */

// ---------------------------------------------------------------------------
// Extraction patterns — deliberately broad on recall, narrow on noise.
// Each pattern captures the sentence or short paragraph containing the signal.
// ---------------------------------------------------------------------------

/** Match a sentence (ending at period, newline, or end-of-text). */
const sentenceAround = (re: RegExp, text: string, max = 300): string[] => {
  const matches: string[] = [];
  // Split into sentence-ish chunks.
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 10);
  for (const s of sentences) {
    if (re.test(s)) {
      matches.push(s.trim().slice(0, max));
    }
  }
  return matches;
};

// --- English language requirements -------------------------------------------
const ENGLISH_RE =
  /\b(ielts|toefl|pte[-\s]?academic|pte|cambridge[-\s]?english|duolingo[-\s]?english|english[-\s]?language[-\s]?requirement|english[-\s]?proficiency|english[-\s]?test)\b/i;
const ENGLISH_SCORE_RE =
  /\b(ielts|toefl|pte|cambridge|duolingo)\b[\s:]*(?:overall\s*)?(?:score\s*(?:of\s*)?)?\d+(?:\.\d+)?/i;

// --- Academic requirements ---------------------------------------------------
const ACADEMIC_RE =
  /\b(gpa|grade[-\s]?point[-\s]?average|a[-\s]?levels?|gcse|ib[-\s]?diploma|international[-\s]?baccalaureate|high[-\s]?school[-\s]?diploma|bachelor'?s?[-\s]?degree|undergraduate[-\s]?degree|academic[-\s]?requirements?|academic[-\s]?qualifications?|minimum[-\s]?qualifications?|entry[-\s]?qualifications?|recognised[-\s]?qualifications?|equivalent[-\s]?qualifications?)\b/i;

// --- Country-specific requirements -------------------------------------------
const COUNTRY_RE =
  /\b(country[-\s]?specific|country[-\s]?requirements?|your[-\s]?country|region[-\s]?specific|from[-\s]?(?:india|china|nigeria|pakistan|bangladesh|usa|uk|canada|australia|europe|asia|africa|middle[-\s]?east)|qualifications?[-\s]?from[-\s]?your[-\s]?country)\b/i;

// --- Application requirements ------------------------------------------------
const APPLICATION_RE =
  /\b(application[-\s]?deadline|how[-\s]?to[-\s]?apply|application[-\s]?process|application[-\s]?requirements?|documents?[-\s]?required|supporting[-\s]?documents?|personal[-\s]?statement|statement[-\s]?of[-\s]?purpose|letter[-\s]?of[-\s]?recommendation|reference[-\s]?letters?|transcript|portfolio[-\s]?required|apply[-\s]?(?:online|now|by|before|through))\b/i;

export interface EligibilityDetails {
  english_requirement: string | null;
  academic_requirement: string | null;
  country_requirement: string | null;
  application_requirement: string | null;
}

/**
 * Extract eligibility details from visible page text. Returns null fields
 * when no signal was found — callers should only write non-null fields.
 */
export function extractEligibilityDetails(text: string): EligibilityDetails {
  const clean = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const englishSentences = sentenceAround(ENGLISH_RE, clean);
  const scoreSentences = sentenceAround(ENGLISH_SCORE_RE, clean);
  const english = [...new Set([...scoreSentences, ...englishSentences])].slice(0, 3).join(" | ") || null;

  const academic = sentenceAround(ACADEMIC_RE, clean).slice(0, 3).join(" | ") || null;
  const country = sentenceAround(COUNTRY_RE, clean).slice(0, 3).join(" | ") || null;
  const application = sentenceAround(APPLICATION_RE, clean).slice(0, 3).join(" | ") || null;

  return {
    english_requirement: english,
    academic_requirement: academic,
    country_requirement: country,
    application_requirement: application,
  };
}

/**
 * Format extracted details into a readable multiline string suitable for
 * storage in the `evidence` text field. Returns null if nothing was found.
 */
export function formatEligibilityEvidence(details: EligibilityDetails): string | null {
  const lines: string[] = [];
  if (details.english_requirement) lines.push(`[English] ${details.english_requirement}`);
  if (details.academic_requirement) lines.push(`[Academic] ${details.academic_requirement}`);
  if (details.country_requirement) lines.push(`[Country] ${details.country_requirement}`);
  if (details.application_requirement) lines.push(`[Application] ${details.application_requirement}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Confidence score for how complete the eligibility extraction is.
 * Each field found adds 25% — 100% means all 4 fields were extracted.
 */
export function eligibilityConfidence(details: EligibilityDetails): number {
  let score = 0;
  if (details.english_requirement) score += 25;
  if (details.academic_requirement) score += 25;
  if (details.country_requirement) score += 25;
  if (details.application_requirement) score += 25;
  return score;
}
