import type { CandidateChunk, Section } from "@clg/shared";

/** Course-name detection (Section 29). */
export const COURSE_REGEX =
  /\b(Bachelor of|B\.?Sc|B\.?A\b|B\.?Eng|B\.?Tech|B\.?E\b|BBA|LLB|MBBS|Major in|Programme? in|Degree in)/i;

/** Eligibility-signal keywords (Section 29). */
export const CRITERIA_SIGNALS = [
  "must",
  "minimum",
  "required",
  "eligibility",
  "eligible",
  "entry requirement",
  "admission requirement",
  "academic requirement",
  "grade",
  "percentage",
  "marks",
  "gpa",
  "grade 12",
  "a-level",
  "ib",
  "sat",
  "act",
  "ielts",
  "toefl",
  "pte",
  "duolingo",
  "mathematics",
  "physics",
  "chemistry",
  "biology",
  "english",
];

const signalRegex = new RegExp(
  `\\b(${CRITERIA_SIGNALS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

export function hasCourseSignal(text: string): boolean {
  return COURSE_REGEX.test(text);
}

export function hasCriteriaSignal(text: string): boolean {
  return signalRegex.test(text);
}

/** First course name found in a chunk, if any (used as a candidate hint). */
export function extractCourseHint(text: string, heading: string | null): string | null {
  if (heading && COURSE_REGEX.test(heading)) return heading.trim();
  const m = text.match(
    /\b(Bachelor of [A-Z][\w &]+|B\.?Sc\.?[\w. ]*|B\.?A\.?[\w. ]*|B\.?Tech[\w. ]*|BBA|LLB|MBBS)/,
  );
  return m ? m[0].trim() : null;
}

export interface CandidateResult {
  candidates: CandidateChunk[];
  totalChunks: number;
  filteredOut: number;
  /** Fraction of chunks rejected before any LLM call. Target >= 0.70 (fix #6). */
  filterRate: number;
}

/**
 * Pass 1 (Section 26): cheaply reject the majority of chunks before they ever
 * reach the LLM. A chunk is a candidate only if it shows a course signal, a
 * criteria signal, or carries a table (tables are admission-data dense). This is
 * the throughput lever — parsing is the bottleneck, not crawling.
 */
export function detectCandidates(sections: Section[]): CandidateResult {
  const candidates: CandidateChunk[] = [];

  for (const s of sections) {
    const blob = `${s.heading ?? ""}\n${s.body}`;
    const course = hasCourseSignal(blob);
    const criteria = hasCriteriaSignal(blob);
    const hasTable = s.tables.length > 0;
    if (!course && !criteria && !hasTable) continue;

    let hint = 0.2;
    if (course) hint += 0.3;
    if (criteria) hint += 0.3;
    if (hasTable) hint += 0.2;

    candidates.push({
      possible_course_name: extractCourseHint(blob, s.heading),
      nearby_text: s.body,
      heading: s.heading,
      tables: s.tables,
      source_url: s.source_url,
      page_title: s.page_title,
      university_id: s.university_id,
      confidence_hint: Math.min(hint, 1),
    });
  }

  const total = sections.length;
  const filteredOut = total - candidates.length;
  return {
    candidates,
    totalChunks: total,
    filteredOut,
    filterRate: total === 0 ? 0 : filteredOut / total,
  };
}
