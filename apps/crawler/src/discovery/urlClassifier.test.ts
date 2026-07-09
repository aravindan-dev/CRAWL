import { describe, it, expect } from "vitest";
import { PageClass } from "@clg/shared";
import { classifyUrl } from "./urlClassifier.js";

describe("classifyUrl — AUDIENCE: domestic-only sections are never fetched (default mode)", () => {
  it("classifies a domestic scholarship section as IRRELEVANT (never fetched, in any context)", () => {
    const c = classifyUrl({ url: "https://www.sydney.edu.au/scholarships/domestic/postgraduate-research/general.html" });
    expect(c.pageClass).toBe(PageClass.IRRELEVANT);
    expect(c.reason).toContain("domestic");
  });

  it("classifies a /home-students/ admissions section as IRRELEVANT", () => {
    const c = classifyUrl({ url: "https://example.edu/admissions/home-students/how-to-apply" });
    expect(c.pageClass).toBe(PageClass.IRRELEVANT);
  });

  it("does NOT flag the international counterpart of the same site structure", () => {
    const c = classifyUrl({ url: "https://www.sydney.edu.au/scholarships/international/postgraduate-research/general.html" });
    expect(c.pageClass).not.toBe(PageClass.IRRELEVANT);
  });

  it("does not misfire on a slug that merely contains the substring (word-boundary safe)", () => {
    const c = classifyUrl({ url: "https://example.edu/courses/domesticated-animal-science-bsc" });
    expect(c.pageClass).not.toBe(PageClass.IRRELEVANT);
  });
});

describe("classifyUrl — baseline sanity (unaffected by the domestic-gate addition)", () => {
  it("classifies an individual scholarship path as SCHOLARSHIP_PAGE", () => {
    const c = classifyUrl({ url: "https://example.edu/scholarships/vice-chancellors-international" });
    expect(c.pageClass).toBe(PageClass.SCHOLARSHIP_PAGE);
  });

  it("classifies a course catalog page as COURSE_PAGE", () => {
    const c = classifyUrl({ url: "https://example.edu/courses/computer-science-bsc" });
    expect(c.pageClass).toBe(PageClass.COURSE_PAGE);
  });

  it("classifies a scholarship category/listing page as SCHOLARSHIP_LISTING", () => {
    const c = classifyUrl({ url: "https://example.edu/scholarships/equity" });
    expect(c.pageClass).toBe(PageClass.SCHOLARSHIP_LISTING);
  });

  it("classifies a login page as IRRELEVANT via the pre-existing hard filter", () => {
    const c = classifyUrl({ url: "https://example.edu/login" });
    expect(c.pageClass).toBe(PageClass.IRRELEVANT);
  });
});

describe("classifyUrl — enriched course-finder vocabulary (sell §285)", () => {
  it("classifies a study-options hub as a course listing (discovery surface)", () => {
    const c = classifyUrl({ url: "https://example.edu/study-options" });
    expect(c.pageClass).toBe(PageClass.COURSE_LISTING);
  });

  it("classifies a prospectus/course-catalogue hub as a course listing", () => {
    const c = classifyUrl({ url: "https://example.edu/prospectus" });
    expect(c.pageClass).toBe(PageClass.COURSE_LISTING);
  });
});
