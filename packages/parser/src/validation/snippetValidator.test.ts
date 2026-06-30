import { describe, it, expect } from "vitest";
import { checkSnippet, validateSnippets } from "./snippetValidator.js";
import type { ParsedCourseCriteria } from "@clg/shared";

const pageText =
  "Admission requirements: Applicants must have completed Grade 12 with Mathematics " +
  "and a minimum overall average of 75%. IELTS 6.5 overall is required for English.";

describe("checkSnippet", () => {
  it("accepts an exact substring", () => {
    const r = checkSnippet("minimum overall average of 75%", pageText);
    expect(r.valid).toBe(true);
    expect(r.similarity).toBe(1);
  });

  it("accepts a near-match above the fuzzy threshold", () => {
    const r = checkSnippet("minimum overall average of 75 percent", pageText, 0.7);
    expect(r.similarity).toBeGreaterThan(0.7);
  });

  it("rejects text not present on the page", () => {
    const r = checkSnippet("a degree in basket weaving with no requirements", pageText);
    expect(r.valid).toBe(false);
  });
});

describe("validateSnippets", () => {
  it("lowers confidence and flags records whose snippet is invalid", () => {
    const base: ParsedCourseCriteria = {
      university_name: "U",
      course_name: "Bachelor of CS",
      degree_level: "Bachelor",
      criteria: "x",
      required_subjects: [],
      minimum_marks: null,
      entrance_exam: null,
      english_requirement: null,
      criteria_url: "https://x",
      source_snippet: "this text is nowhere on the page at all",
      confidence_score: 0.9,
      parser_type: "ai",
      source_language: "en",
    };
    const [out] = validateSnippets([base], pageText);
    expect(out!.confidence_score).toBe(0.3);
    expect((out as { __snippet_invalid?: boolean }).__snippet_invalid).toBe(true);
  });
});
