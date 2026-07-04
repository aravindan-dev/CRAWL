/**
 * Regression tests for the refactored VALIDATION ENGINE: course identity is
 * validated BEFORE course-level eligibility evidence; general pages stay
 * discovery-only; scholarship validation stays scholarship-scoped; decisions
 * are explainable.
 */
import { describe, it, expect } from "vitest";
import { CrawlContext, PageClass } from "@clg/shared";
import { validateTarget, TargetOutcome } from "./validateTarget.js";

const base = "https://www.example.edu";

const COURSE_TEXT = `
  BSc (Hons) Computer Science. Duration: 3 years full-time. Start dates: September.
  Course overview — what you'll study: modules include algorithms and data structures.
  Entry requirements: AAB at A-level including Mathematics. International students:
  IELTS 6.5 overall with minimum 6.0 in each component.
`;

const COURSE_TEXT_NO_EVIDENCE = `
  BSc (Hons) Computer Science. Duration: 3 years full-time.
  Course overview — what you'll study: modules include algorithms, databases and AI.
  Our graduates work at leading software companies.
`;

const GENERAL_INTL_TEXT = `
  International entry requirements. Find the entry requirements for your country.
  We accept a wide range of international qualifications. English language:
  IELTS 6.0 or TOEFL 80. Contact the admissions office for details of your course.
`;

const SCHOLARSHIP_TEXT = `
  Vice-Chancellor's International Scholarship. A tuition fee waiver of £5,000 for
  outstanding international students. Eligibility criteria: hold an offer for a
  full-time course. How to apply for this scholarship before the deadline.
`;

describe("Scenario 4: individual course page with an Entry Requirements accordion", () => {
  it("is identified as a course, evidence detected, MAIN course URL accepted", () => {
    const v = validateTarget({
      context: CrawlContext.ELIGIBILITY,
      finalUrl: `${base}/courses/computer-science-bsc`,
      pageClass: PageClass.COURSE_PAGE,
      title: "Computer Science BSc (Hons)",
      text: COURSE_TEXT,
      hasEntryAnchor: false,
      factCount: 2,
    });
    expect(v.outcome).toBe(TargetOutcome.VALIDATED_TARGET);
    expect(v.targetType).toBe("COURSE");
    expect(v.courseIdentity).toBe(true);
    expect(v.evidence.length).toBeGreaterThan(0);
  });
});

describe("Scenario 5: course page whose requirements live at a same-page anchor", () => {
  it("validates via the anchor; the anchor stays secondary (evidence), never the target", () => {
    const v = validateTarget({
      context: CrawlContext.ELIGIBILITY,
      finalUrl: `${base}/courses/mechanical-engineering-beng`,
      pageClass: PageClass.COURSE_PAGE,
      title: "Mechanical Engineering BEng",
      text: COURSE_TEXT_NO_EVIDENCE, // requirements render in a modal — not in flat text
      hasEntryAnchor: true,
      factCount: 1,
    });
    expect(v.outcome).toBe(TargetOutcome.VALIDATED_TARGET);
    expect(v.targetType).toBe("COURSE");
    expect(v.evidence).toContain("anchor");
  });
  it("a course page without evidence anywhere is DISCOVERY_ONLY, not a target", () => {
    const v = validateTarget({
      context: CrawlContext.ELIGIBILITY,
      finalUrl: `${base}/courses/mechanical-engineering-beng`,
      pageClass: PageClass.COURSE_PAGE,
      title: "Mechanical Engineering BEng",
      text: COURSE_TEXT_NO_EVIDENCE,
      hasEntryAnchor: false,
      factCount: 1,
    });
    expect(v.outcome).toBe(TargetOutcome.DISCOVERY_ONLY);
    expect(v.reasons[0]).toContain("no course-level eligibility evidence");
  });
});

describe("Scenario 6: general international entry-requirements page", () => {
  it("may be used for discovery but is NEVER a final individual-course result", () => {
    const v = validateTarget({
      context: CrawlContext.ELIGIBILITY,
      finalUrl: `${base}/international/entry-requirements`,
      pageClass: PageClass.INTERNATIONAL_ADMISSIONS_PAGE,
      title: "International entry requirements",
      text: GENERAL_INTL_TEXT, // contains plenty of eligibility keywords…
      hasEntryAnchor: true, // …and even an anchor
      factCount: 0,
    });
    expect(v.outcome).toBe(TargetOutcome.DISCOVERY_ONLY); // …but no course identity
    expect(v.targetType).toBeNull();
    expect(v.reasons[0]).toContain("not an individual course");
  });
  it("same for a general admissions page (keywords alone never make a target)", () => {
    const v = validateTarget({
      context: CrawlContext.ELIGIBILITY,
      finalUrl: `${base}/admissions`,
      pageClass: PageClass.ADMISSIONS_PAGE,
      title: "Admissions",
      text: GENERAL_INTL_TEXT,
      hasEntryAnchor: false,
      factCount: 0,
    });
    expect(v.outcome).toBe(TargetOutcome.DISCOVERY_ONLY);
  });
});

describe("Scenario 7: course index page", () => {
  it("is fetchable for discovery but never exported as an individual course", () => {
    const v = validateTarget({
      context: CrawlContext.ELIGIBILITY,
      finalUrl: `${base}/courses`,
      pageClass: PageClass.COURSE_LISTING,
      title: "Our courses",
      text: "Browse all 300 undergraduate courses. Filter by subject. Entry requirements vary by course.",
      hasEntryAnchor: false,
      factCount: 0,
    });
    expect(v.outcome).toBe(TargetOutcome.DISCOVERY_ONLY);
    expect(v.reasons[0]).toContain("listing");
  });
});

describe("course identity must be CONTENT-corroborated (stage 1 before stage 2)", () => {
  it("a course-like URL whose content shows no award/structure/detail is not a course", () => {
    const v = validateTarget({
      context: CrawlContext.ELIGIBILITY,
      finalUrl: `${base}/courses/open-day-parking`,
      pageClass: PageClass.COURSE_PAGE,
      title: "Parking information",
      text: "Directions and parking for your visit. Please arrive early. Eligibility for permits is limited.",
      hasEntryAnchor: false,
      factCount: 0,
    });
    expect(v.outcome).toBe(TargetOutcome.DISCOVERY_ONLY);
    expect(v.courseIdentity).toBe(false);
    expect(v.reasons[0]).toBe("no course identity");
  });
});

describe("Scenario 10: redirect crosses context", () => {
  it("eligibility crawl: a fetch that LANDED on a scholarship page is REJECTED", () => {
    const v = validateTarget({
      context: CrawlContext.ELIGIBILITY,
      finalUrl: `${base}/scholarships/international-merit`,
      pageClass: PageClass.SCHOLARSHIP_PAGE, // classification of the FINAL url
      title: "International Merit Scholarship",
      text: SCHOLARSHIP_TEXT,
      hasEntryAnchor: false,
      factCount: 0,
    });
    expect(v.outcome).toBe(TargetOutcome.REJECTED);
    expect(v.reasons[0]).toBe("scholarship page in eligibility context");
  });
  it("scholarship crawl: a fetch that LANDED on a course/eligibility page is REJECTED", () => {
    const v = validateTarget({
      context: CrawlContext.SCHOLARSHIP,
      finalUrl: `${base}/courses/computer-science-bsc`,
      pageClass: PageClass.COURSE_PAGE,
      title: "Computer Science BSc",
      text: COURSE_TEXT,
      hasEntryAnchor: false,
      factCount: 2,
    });
    expect(v.outcome).toBe(TargetOutcome.REJECTED);
    expect(v.reasons[0]).toBe("eligibility or course page in scholarship context");
  });
});

describe("scholarship validation (scholarship context)", () => {
  it("accepts an individual scholarship page with scholarship evidence", () => {
    const v = validateTarget({
      context: CrawlContext.SCHOLARSHIP,
      finalUrl: `${base}/scholarships/vice-chancellors-international`,
      pageClass: PageClass.SCHOLARSHIP_PAGE,
      title: "Vice-Chancellor's International Scholarship",
      text: SCHOLARSHIP_TEXT,
      hasEntryAnchor: false,
      factCount: 0,
    });
    expect(v.outcome).toBe(TargetOutcome.VALIDATED_TARGET);
    expect(v.targetType).toBe("SCHOLARSHIP");
  });
  it("keeps scholarship LISTINGS as discovery-only", () => {
    const v = validateTarget({
      context: CrawlContext.SCHOLARSHIP,
      finalUrl: `${base}/scholarships`,
      pageClass: PageClass.SCHOLARSHIP_LISTING,
      title: "Scholarships",
      text: SCHOLARSHIP_TEXT,
      hasEntryAnchor: false,
      factCount: 0,
    });
    expect(v.outcome).toBe(TargetOutcome.DISCOVERY_ONLY);
  });
  it("word 'eligibility' on a scholarship page never turns it into an eligibility target", () => {
    const v = validateTarget({
      context: CrawlContext.SCHOLARSHIP,
      finalUrl: `${base}/scholarships/deans-award`,
      pageClass: PageClass.SCHOLARSHIP_PAGE,
      title: "Dean's Award",
      text: SCHOLARSHIP_TEXT, // contains "Eligibility criteria: …"
      hasEntryAnchor: false,
      factCount: 0,
    });
    expect(v.targetType).not.toBe("COURSE");
  });
});

describe("decisions are explainable", () => {
  it("every outcome carries reasons and a confidence", () => {
    const v = validateTarget({
      context: CrawlContext.ELIGIBILITY,
      finalUrl: `${base}/admissions`,
      pageClass: PageClass.ADMISSIONS_PAGE,
      title: "Admissions",
      text: GENERAL_INTL_TEXT,
      hasEntryAnchor: false,
      factCount: 0,
    });
    expect(v.reasons.length).toBeGreaterThan(0);
    expect(v.confidence).toBeGreaterThanOrEqual(0);
    expect(v.confidence).toBeLessThanOrEqual(1);
  });
});
