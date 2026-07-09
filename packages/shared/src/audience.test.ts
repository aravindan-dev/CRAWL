import { describe, it, expect } from "vitest";
import { isDomesticPath, isDomesticText } from "./audience.js";

describe("isDomesticPath", () => {
  it("flags a URL whose path names a domestic/home section", () => {
    expect(isDomesticPath("https://www.sydney.edu.au/scholarships/domestic/postgraduate-research/general.html")).toBe(true);
    expect(isDomesticPath("https://example.edu/admissions/home-students/apply")).toBe(true);
    expect(isDomesticPath("https://example.edu/local-students/fees")).toBe(true);
  });

  it("does not flag an international/general page", () => {
    expect(isDomesticPath("https://www.sydney.edu.au/scholarships/international/postgraduate-research/general.html")).toBe(false);
    expect(isDomesticPath("https://example.edu/courses/computer-science-bsc")).toBe(false);
  });

  it("does not flag a slug that merely CONTAINS the word (not a path segment)", () => {
    expect(isDomesticPath("https://example.edu/courses/domesticated-animal-science-bsc")).toBe(false);
  });

  it("returns false for a malformed URL instead of throwing", () => {
    expect(isDomesticPath("not a url")).toBe(false);
  });
});

describe("isDomesticText", () => {
  it("flags text that explicitly scopes itself to domestic/home students", () => {
    expect(isDomesticText("This scholarship is open to domestic students only.")).toBe(true);
    expect(isDomesticText("Available to home students with home fee status.")).toBe(true);
  });

  it("does not flag ordinary international-facing text", () => {
    expect(isDomesticText("Open to international students. IELTS 6.5 required.")).toBe(false);
  });

  it("handles empty text", () => {
    expect(isDomesticText("")).toBe(false);
  });
});
