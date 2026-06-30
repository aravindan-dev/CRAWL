import { describe, it, expect } from "vitest";
import { dedupeRecords, canonicalCourseKey } from "./dedup.js";
import type { ParsedCourseCriteria } from "@clg/shared";

function rec(name: string, url: string, conf: number): ParsedCourseCriteria {
  return {
    university_name: "U",
    course_name: name,
    degree_level: "Bachelor",
    criteria: "x",
    required_subjects: [],
    minimum_marks: null,
    entrance_exam: null,
    english_requirement: null,
    criteria_url: url,
    source_snippet: "x",
    confidence_score: conf,
    parser_type: "ai",
    source_language: "en",
  };
}

describe("canonicalCourseKey", () => {
  it("normalizes case, punctuation and whitespace", () => {
    expect(canonicalCourseKey("  B.Sc.  Computer   Science! ")).toBe("b sc computer science");
  });
});

describe("dedupeRecords", () => {
  it("dedupes same course + same URL, keeping higher confidence", () => {
    const out = dedupeRecords([
      rec("Bachelor of CS", "https://e.edu/cs", 0.6),
      rec("bachelor of cs", "https://e.edu/cs", 0.9),
    ]);
    const dupes = out.filter((o) => o.isDuplicate);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.record.confidence_score).toBe(0.6); // loser flagged
  });

  it("keeps same course at different URLs (cross-URL variants, grouped not removed)", () => {
    const out = dedupeRecords([
      rec("Bachelor of CS", "https://e.edu/cs", 0.8),
      rec("Bachelor of CS", "https://e.edu/programs/cs", 0.8),
    ]);
    expect(out.every((o) => !o.isDuplicate)).toBe(true);
  });
});
