import {
  type EligibilityParser,
  type ParserInput,
  type ParsedCourseCriteria,
  type Section,
  type DegreeLevel,
} from "@clg/shared";
import {
  COURSE_REGEX,
  hasCriteriaSignal,
  extractCourseHint,
  detectCandidates,
} from "../candidate.js";

const SUBJECTS = [
  "Mathematics",
  "Calculus",
  "Physics",
  "Chemistry",
  "Biology",
  "English",
  "Economics",
  "Accounting",
  "Statistics",
  "Computer Science",
];

function firstMatch(re: RegExp, text: string): string | null {
  const m = text.match(re);
  return m ? m[0].trim() : null;
}

export function extractMinimumMarks(text: string): string | null {
  // "minimum 75%", "at least 60 %", "75% overall", "75 percent"
  // Note: no trailing \b after "%" — "%" → space is not a word boundary.
  const pct = text.match(/(\d{2,3})\s*(?:%|percent\b)/i);
  if (pct) return `${pct[1]}%`;
  return null;
}

export function extractGpa(text: string): string | null {
  const m = text.match(/\bGPA\b[^0-9]{0,8}(\d(?:\.\d{1,2})?)|(\d(?:\.\d{1,2})?)\s*GPA\b/i);
  if (!m) return null;
  const val = m[1] ?? m[2];
  return val ? `GPA ${val}` : null;
}

export function extractALevels(text: string): string | null {
  // "A-levels AAB", "A level grades BBB"
  const m = text.match(/A[- ]?levels?[^A-E]{0,12}([A-E]{2,4}(?:\*?))/i);
  return m && m[1] ? `A-levels ${m[1]}` : null;
}

export function extractSubjects(text: string): string[] {
  const found = new Set<string>();
  for (const s of SUBJECTS) {
    if (new RegExp(`\\b${s}\\b`, "i").test(text)) found.add(s);
  }
  return [...found];
}

export function extractEntranceExam(text: string): string | null {
  const exams = ["SAT", "ACT", "UCAT", "BMAT", "JEE", "NEET", "entrance exam", "entrance test"];
  for (const e of exams) {
    if (new RegExp(`\\b${e}\\b`, "i").test(text)) return e;
  }
  return null;
}

export function extractEnglishRequirement(text: string): string | null {
  const parts: string[] = [];
  const ielts = text.match(/IELTS[^0-9]{0,8}(\d(?:\.\d)?)/i);
  if (ielts) parts.push(`IELTS ${ielts[1]}`);
  const toefl = text.match(/TOEFL[^0-9]{0,12}(\d{2,3})/i);
  if (toefl) parts.push(`TOEFL ${toefl[1]}`);
  const pte = text.match(/PTE[^0-9]{0,8}(\d{2,3})/i);
  if (pte) parts.push(`PTE ${pte[1]}`);
  const duo = text.match(/Duolingo[^0-9]{0,8}(\d{2,3})/i);
  if (duo) parts.push(`Duolingo ${duo[1]}`);
  return parts.length ? parts.join(", ") : null;
}

function detectDegreeLevel(text: string): DegreeLevel {
  if (/\bdiploma\b/i.test(text)) return "Diploma";
  if (COURSE_REGEX.test(text)) return "Bachelor";
  return "Other";
}

/** Pick the most criteria-dense sentence as the verbatim source_snippet. */
function pickSnippet(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  let best = sentences[0] ?? text.slice(0, 280);
  let bestScore = -1;
  for (const s of sentences) {
    if (s.length < 25) continue;
    const score = (s.match(/\d+%|GPA|IELTS|TOEFL|grade|minimum|require/gi) ?? []).length;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best.trim().slice(0, 500);
}

function buildRecord(
  input: ParserInput,
  section: Section | null,
  blob: string,
): ParsedCourseCriteria | null {
  const courseHint = extractCourseHint(blob, section?.heading ?? null);
  const criteriaPresent = hasCriteriaSignal(blob);

  // Section 25/12: need at least a course OR clear criteria to emit a record.
  if (!courseHint && !criteriaPresent) return null;

  const minimum_marks = extractMinimumMarks(blob);
  const gpa = extractGpa(blob);
  const required_subjects = extractSubjects(blob);
  const entrance_exam = extractEntranceExam(blob);
  const english_requirement = extractEnglishRequirement(blob);

  // Confidence: base 0.5 + 0.1 per structured field, capped at 0.75 (Section 29).
  let confidence = 0.5;
  for (const present of [
    !!minimum_marks || !!gpa,
    required_subjects.length > 0,
    !!entrance_exam,
    !!english_requirement,
    !!courseHint,
  ]) {
    if (present) confidence += 0.1;
  }
  confidence = Math.min(confidence, 0.75);

  const criteriaText = criteriaPresent ? pickSnippet(blob) : null;

  return {
    university_name: input.university_name,
    course_name: courseHint ?? "Unknown Course",
    degree_level: detectDegreeLevel(blob),
    criteria: criteriaText,
    required_subjects,
    minimum_marks: minimum_marks ?? gpa,
    entrance_exam,
    english_requirement,
    criteria_url: input.source_url, // re-affirmed by orchestrator invariant
    source_snippet: pickSnippet(blob),
    confidence_score: confidence,
    parser_type: "rule_based",
    source_language: "en",
  };
}

/**
 * Rule-based fallback parser. Runs entirely on signals/regex — no network. Used
 * when AI is disabled/unavailable and as the safety net behind every AI parse.
 * Rule-based records are never auto-approved (Section 29).
 */
export class RuleBasedEligibilityParser implements EligibilityParser {
  async parseEligibility(input: ParserInput): Promise<ParsedCourseCriteria[]> {
    const records: ParsedCourseCriteria[] = [];

    if (input.sections.length > 0) {
      const { candidates } = detectCandidates(input.sections);
      const sectionByUrlHeading = new Map(
        input.sections.map((s) => [`${s.chunk_index}`, s] as const),
      );
      for (const c of candidates) {
        const blob = `${c.heading ?? ""}\n${c.nearby_text}`;
        // Find the originating section for table context (best-effort).
        const section =
          [...sectionByUrlHeading.values()].find(
            (s) => s.heading === c.heading && s.body === c.nearby_text,
          ) ?? null;
        const rec = buildRecord(input, section, blob);
        if (rec) records.push(rec);
      }
    }

    // Fallback: whole-page pass if section-based produced nothing.
    if (records.length === 0) {
      const rec = buildRecord(input, null, input.cleaned_text);
      if (rec) records.push(rec);
    }

    return records;
  }
}
