import { describe, it, expect } from "vitest";
import { enforceUrlInvariant, assertUrlInvariant } from "./urlInvariant.js";
import type { ParsedCourseCriteria } from "@clg/shared";

function rec(url: string): ParsedCourseCriteria {
  return {
    university_name: "U",
    course_name: "Bachelor of X",
    degree_level: "Bachelor",
    criteria: "min 60%",
    required_subjects: [],
    minimum_marks: "60%",
    entrance_exam: null,
    english_requirement: null,
    criteria_url: url,
    source_snippet: "min 60%",
    confidence_score: 0.7,
    parser_type: "ai",
    source_language: "en",
  };
}

describe("enforceUrlInvariant", () => {
  it("overwrites a hallucinated criteria_url with the real source_url", () => {
    const source = "https://example.edu/admissions/cs/requirements";
    const records = [rec("https://example.edu"), rec("https://totally-wrong.example")];
    const out = enforceUrlInvariant(records, source);
    expect(out.every((r) => r.criteria_url === source)).toBe(true);
    expect(assertUrlInvariant(out, source)).toBe(true);
  });

  it("throws when source_url is not http(s)", () => {
    expect(() => enforceUrlInvariant([rec("https://x")], "ftp://nope")).toThrow();
  });
});
