import { describe, it, expect } from "vitest";
import { isRealCourse, courseNameFromUrl, deriveCourseName, canonicalCourseUrl, isCourseCode } from "./courseUrl.js";

const C = (path: string) => `https://www.canberra.edu.au${path}`;

describe("isCourseCode", () => {
  it("accepts compact alphanumeric course codes", () => {
    for (const code of ["MGM102", "ABAB01", "245JA", "723AA", "ARAR02", "EDM101", "ARMG01"]) {
      expect(isCourseCode(code)).toBe(true);
    }
  });
  it("rejects bare years and plain words/numbers", () => {
    expect(isCourseCode("2026")).toBe(false);
    expect(isCourseCode("2024")).toBe(false);
    expect(isCourseCode("courses")).toBe(false);
    expect(isCourseCode("123")).toBe(false);
  });
});

describe("isRealCourse — code-based course URLs (the canberra bug)", () => {
  it("accepts the HTML course page for a code-based course", () => {
    // These were WRONGLY rejected before (no 3-letter run in '245JA'/'723AA').
    expect(isRealCourse(C("/course/245JA/3/2026").toLowerCase())).toBe(true);
    expect(isRealCourse(C("/course/723AA/6").toLowerCase())).toBe(true);
    expect(isRealCourse(C("/course/MGM102/2/2026").toLowerCase())).toBe(true);
    expect(isRealCourse(C("/course/ABAB01/1/2026").toLowerCase())).toBe(true);
  });
  it("still accepts word-slug course pages", () => {
    expect(isRealCourse("https://uni.edu/courses/ug/yacht-design-beng".toLowerCase())).toBe(true);
  });
  it("rejects listing / generic pages", () => {
    expect(isRealCourse("https://uni.edu/courses".toLowerCase())).toBe(false);
    expect(isRealCourse("https://uni.edu/courses/undergraduate".toLowerCase())).toBe(false);
  });
});

describe("canonicalCourseUrl — HTML-first collapse of PDF + year variants", () => {
  it("collapses the .pdf prospectus, the year page, and the bare page to ONE HTML url", () => {
    const expected = C("/course/245JA/3");
    expect(canonicalCourseUrl(C("/course/245JA/3"))).toBe(expected);
    expect(canonicalCourseUrl(C("/course/245JA/3/2026"))).toBe(expected);
    expect(canonicalCourseUrl(C("/course/245JA/3/2026.pdf"))).toBe(expected); // PDF → HTML page
    expect(canonicalCourseUrl(C("/course/245JA/3#academicentryrequirementsmodal"))).toBe(expected);
  });
  it("724AA year-pdf maps to its HTML page", () => {
    expect(canonicalCourseUrl(C("/course/723AA/6/2024.pdf"))).toBe(C("/course/723AA/6"));
  });
  it("collapses a slug course's year/intake variants", () => {
    expect(canonicalCourseUrl("https://uni.edu/courses/ug/yacht-beng/2026/full-time")).toBe(
      "https://uni.edu/courses/ug/yacht-beng",
    );
  });
});

describe("course name", () => {
  it("prefers the real page title over the URL", () => {
    expect(
      deriveCourseName("Master of Education Studies (245JA) - University of Canberra", C("/course/245JA/3").toLowerCase()),
    ).toBe("Master of Education Studies (245JA)");
  });
  it("falls back to the bare code (upper-cased) when there is no title — never '2026.pdf'", () => {
    expect(courseNameFromUrl(C("/course/245JA/3").toLowerCase())).toBe("245JA");
    // The old bug produced "2026.pdf"; the PDF segment must never become a name.
    expect(courseNameFromUrl(C("/course/245JA/3/2026.pdf").toLowerCase())).not.toMatch(/pdf/i);
  });
});
