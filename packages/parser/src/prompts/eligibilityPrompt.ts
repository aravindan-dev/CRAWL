import type { ParserInput } from "@clg/shared";

/**
 * The exact extraction system prompt (Section 27). Do not soften these rules —
 * they are what keep the model from hallucinating criteria or URLs.
 */
export const ELIGIBILITY_SYSTEM_PROMPT = `You are a precise university eligibility data extraction engine.

You extract course names and admission eligibility criteria ONLY from the provided webpage text.

Rules:
1. Never invent, infer, assume, or generalize criteria not present in the text.
2. Output ONLY a valid JSON array. No prose. No markdown. No explanation.
3. source_snippet must be a verbatim excerpt from the input text.
4. criteria_url must equal the provided source_url exactly.
5. If criteria text is ambiguous or partial, confidence_score must be below 0.6.
6. If a course is found but criteria is missing, output it with criteria=null.
7. If eligibility criteria is found but the course is unclear, output course_name="Unknown Course".
8. If many courses share the same criteria block, emit one record per course.
9. If no relevant course eligibility information exists, output [].
10. For non-English source text, translate criteria into English, but keep source_snippet verbatim in original language.
11. Do not include postgraduate or PhD programs unless they are mixed into the same undergraduate block and clearly visible.
12. Do not create a record unless there is either a clear course name or clear eligibility criteria.`;

/**
 * Build the user message. When structured output (Ollama `format`) is in use the
 * model still benefits from being told the exact shape and the source_url it must
 * echo into criteria_url.
 */
export function buildEligibilityUserPrompt(input: ParserInput, maxChars: number): string {
  const text = input.cleaned_text.slice(0, maxChars);
  const tableBlock =
    input.tables.length > 0
      ? `\n\nTABLES (JSON):\n${JSON.stringify(input.tables).slice(0, Math.floor(maxChars / 3))}`
      : "";

  return `university_name: ${input.university_name}
source_url: ${input.source_url}
page_title: ${input.page_title}

Return a JSON object: { "courses": ParsedCourseCriteria[] }.
Each ParsedCourseCriteria has: university_name, course_name, degree_level
("Bachelor"|"Diploma"|"Other"), criteria (string|null), required_subjects (string[]),
minimum_marks (string|null), entrance_exam (string|null), english_requirement (string|null),
criteria_url (string, MUST equal source_url above), source_snippet (verbatim excerpt),
confidence_score (0..1), parser_type ("ai"), source_language (ISO code).

WEBPAGE TEXT:
${text}${tableBlock}`;
}
