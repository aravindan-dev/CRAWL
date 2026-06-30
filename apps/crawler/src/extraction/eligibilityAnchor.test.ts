import { describe, it, expect } from "vitest";
import { entryRequirementAnchor, deepLinkEligibility } from "./eligibilityAnchor.js";

describe("entryRequirementAnchor", () => {
  it("finds Canberra's academic-entry-requirements modal by its link label", () => {
    const html = `
      <a href="#academicentryrequirementsmodal">View academic entry requirements</a>
      <div id="academicentryrequirementsmodal">…IELTS 6.5…</div>`;
    expect(entryRequirementAnchor(html)).toBe("academicentryrequirementsmodal");
  });

  it("finds an id-based entry-requirements section", () => {
    const html = `<section id="entry-requirements"><h2>Entry requirements</h2></section>`;
    expect(entryRequirementAnchor(html)).toBe("entry-requirements");
  });

  it("prefers the international-entry section when several match", () => {
    const html = `
      <a href="#entry-requirements">Entry requirements</a>
      <a href="#international-entry-requirements">International entry requirements</a>`;
    expect(entryRequirementAnchor(html)).toBe("international-entry-requirements");
  });

  it("returns null when the page has no entry-requirements anchor", () => {
    expect(entryRequirementAnchor(`<a href="#overview">Overview</a><div id="fees">…</div>`)).toBeNull();
    expect(entryRequirementAnchor("")).toBeNull();
  });
});

describe("deepLinkEligibility", () => {
  it("appends the anchor to the page URL (the exact eligibility link)", () => {
    const html = `<a href="#academicentryrequirementsmodal">Academic entry requirements</a>`;
    expect(deepLinkEligibility("https://www.canberra.edu.au/course/MGM102/2/2026", html)).toBe(
      "https://www.canberra.edu.au/course/MGM102/2/2026#academicentryrequirementsmodal",
    );
  });
  it("leaves the URL unchanged when no anchor is found", () => {
    expect(deepLinkEligibility("https://uni.edu/courses/x", `<div id="fees"></div>`)).toBe("https://uni.edu/courses/x");
  });
  it("replaces an existing hash and trailing slash cleanly", () => {
    const html = `<section id="entry-requirements"></section>`;
    expect(deepLinkEligibility("https://uni.edu/courses/x/#top", html)).toBe("https://uni.edu/courses/x#entry-requirements");
  });
});
