import { describe, it, expect } from "vitest";
import { PageClass } from "@clg/shared";
import { shouldFetchForDiscovery } from "./crawlScope.js";

const base = { catalogDriven: true, depth: 3 } as const;

describe("shouldFetchForDiscovery (catalog-driven scope)", () => {
  it("always follows EXTRACT-tier target candidates", () => {
    expect(
      shouldFetchForDiscovery({ ...base, url: "https://u.edu/anything/deep/x", pageClass: PageClass.UNKNOWN, disposition: "EXTRACT" }),
    ).toBe(true);
  });

  it("follows course/eligibility/scholarship page & listing classes regardless of score", () => {
    for (const pc of [
      PageClass.COURSE_PAGE,
      PageClass.COURSE_LISTING,
      PageClass.ELIGIBILITY_PAGE,
      PageClass.ADMISSIONS_PAGE,
      PageClass.INTERNATIONAL_ADMISSIONS_PAGE,
      PageClass.SCHOLARSHIP_PAGE,
      PageClass.SCHOLARSHIP_LISTING,
      PageClass.FUNDING_PAGE,
    ] as const) {
      expect(
        shouldFetchForDiscovery({ ...base, url: "https://u.edu/x", pageClass: pc, disposition: "DISCOVER_ONLY" }),
      ).toBe(true);
    }
  });

  it("follows course-section navigation hubs", () => {
    for (const p of [
      "https://study.csu.edu.au/courses",
      "https://u.edu/find-courses/short-courses",
      "https://u.edu/study/undergraduate",
      "https://u.edu/international/courses",
      "https://u.edu/faculties/science",
      "https://u.edu/schools/law",
      "https://u.edu/admissions/apply",
      "https://u.edu/scholarships",
      "https://u.edu/funding",
      "https://u.edu/handbook/2026",
    ]) {
      expect(
        shouldFetchForDiscovery({ ...base, url: p, pageClass: PageClass.NAVIGATION_PAGE, disposition: "DISCOVER_ONLY" }),
      ).toBe(true);
    }
  });

  it("does NOT follow generic low-value pages that never lead to the deliverable", () => {
    for (const p of [
      "https://u.edu/studyplan/HCS523",
      "https://u.edu/store/merch",
      "https://u.edu/research/success-stories/x",
      "https://u.edu/current-students/library",
      "https://u.edu/tag/horticulture-courses",
      "https://u.edu/our-university/history",
      "https://insight.u.edu/what-is-inclusive-education",
    ]) {
      expect(
        shouldFetchForDiscovery({ ...base, url: p, pageClass: PageClass.UNKNOWN, disposition: "DISCOVER_ONLY" }),
      ).toBe(false);
    }
  });

  it("always explores the entry page's immediate links (depth ≤ 1) even if generic", () => {
    expect(
      shouldFetchForDiscovery({ catalogDriven: true, depth: 1, url: "https://u.edu/about", pageClass: PageClass.NAVIGATION_PAGE, disposition: "DISCOVER_ONLY" }),
    ).toBe(true);
  });

  it("exhaustive mode (catalogDriven=false) follows anything that scored", () => {
    expect(
      shouldFetchForDiscovery({ catalogDriven: false, depth: 5, url: "https://u.edu/research/x", pageClass: PageClass.UNKNOWN, disposition: "DISCOVER_ONLY" }),
    ).toBe(true);
  });
});
