import { describe, it, expect } from "vitest";
import { RuleBasedEligibilityParser } from "./ruleParser.js";
import {
  extractMinimumMarks,
  extractEnglishRequirement,
  extractSubjects,
} from "./ruleParser.js";
import type { ParserInput } from "@clg/shared";

const parser = new RuleBasedEligibilityParser();

function input(text: string): ParserInput {
  return {
    university_name: "Example University",
    source_url: "https://example.edu/admissions/cs/requirements",
    page_title: "Computer Science Admission Requirements",
    cleaned_text: text,
    sections: [],
    tables: [],
  };
}

describe("field extractors", () => {
  it("extracts a minimum percentage", () => {
    expect(extractMinimumMarks("a minimum overall average of 75%")).toBe("75%");
  });
  it("extracts IELTS/TOEFL", () => {
    expect(extractEnglishRequirement("IELTS 6.5 overall or TOEFL 100")).toBe(
      "IELTS 6.5, TOEFL 100",
    );
  });
  it("extracts known subjects", () => {
    expect(extractSubjects("must include Mathematics and Physics")).toEqual(
      expect.arrayContaining(["Mathematics", "Physics"]),
    );
  });
});

describe("RuleBasedEligibilityParser", () => {
  it("detects a course name and eligibility criteria", async () => {
    const out = await parser.parseEligibility(
      input(
        "Bachelor of Computer Science. Applicants must have completed Grade 12 with " +
          "Mathematics and a minimum overall average of 75%. IELTS 6.5 required.",
      ),
    );
    expect(out.length).toBeGreaterThan(0);
    const rec = out[0]!;
    expect(rec.course_name).toMatch(/Bachelor of Computer Science/i);
    expect(rec.minimum_marks).toBe("75%");
    expect(rec.english_requirement).toContain("IELTS");
    expect(rec.parser_type).toBe("rule_based");
    expect(rec.confidence_score).toBeLessThanOrEqual(0.75);
    // criteria_url must be the source url even pre-orchestrator.
    expect(rec.criteria_url).toBe("https://example.edu/admissions/cs/requirements");
  });

  it("emits Unknown Course when criteria present but course unclear", async () => {
    const out = await parser.parseEligibility(
      input("Entry requirements: minimum 60% in Grade 12 with English and Mathematics."),
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.course_name).toBe("Unknown Course");
  });
});
