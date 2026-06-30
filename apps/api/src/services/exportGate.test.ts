import { describe, it, expect } from "vitest";
import { validateExportRecords } from "./exportGate.js";
import type { CourseCriteria } from "@clg/database";

function rec(partial: Partial<CourseCriteria>): CourseCriteria {
  return {
    id: partial.id ?? "id1",
    university_id: "u1",
    discovered_link_id: null,
    university_name: "U",
    course_name: partial.course_name ?? "Bachelor of CS",
    canonical_course_key: "bachelor of cs",
    degree_level: "Bachelor",
    // Honor an explicitly-passed null (don't let ?? coerce it to a string).
    criteria: "criteria" in partial ? partial.criteria ?? null : "min 60%",
    criteria_url: partial.criteria_url ?? "https://e.edu/cs/requirements",
    source_snippet: partial.source_snippet ?? "min 60%",
    required_subjects: [],
    minimum_marks: null,
    entrance_exam: null,
    english_requirement: null,
    confidence_score: 0.8,
    parser_type: "ai",
    source_language: "en",
    review_status: "APPROVED",
    reviewed_by: null,
    reviewed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as CourseCriteria;
}

describe("validateExportRecords", () => {
  it("aborts approved_only export when a record has null criteria, listing IDs", () => {
    const result = validateExportRecords(
      [rec({ id: "good" }), rec({ id: "bad", criteria: null })],
      "approved_only",
    );
    expect(result.abort).toBe(true);
    expect(result.abortIds).toContain("bad");
  });

  it("aborts approved_only when course_name is Unknown Course", () => {
    const result = validateExportRecords([rec({ id: "x", course_name: "Unknown Course" })], "approved_only");
    expect(result.abort).toBe(true);
    expect(result.abortIds).toContain("x");
  });

  it("includes-but-flags null criteria for the 'all' scope (no abort)", () => {
    const result = validateExportRecords([rec({ id: "n", criteria: null })], "all");
    expect(result.abort).toBe(false);
    expect(result.included).toHaveLength(1);
    expect(result.flagged.map((f) => f.id)).toContain("n");
  });

  it("excludes records missing criteria_url in every scope", () => {
    const result = validateExportRecords(
      [rec({ id: "nourl", criteria_url: "" })],
      "all",
    );
    expect(result.included).toHaveLength(0);
    expect(result.excluded.map((e) => e.id)).toContain("nourl");
  });
});
