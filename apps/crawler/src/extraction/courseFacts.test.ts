import { describe, it, expect } from "vitest";
import { extractCourseFacts } from "./courseFacts.js";

const PAGE_TEXT = `
Bachelor of Agricultural Science
Key information
Duration: 4 years full-time or part-time equivalent
Intakes: February and July
Indicative annual fee AUD $34,800 per year for international students
Application deadline: Applications close 30 November 2026
Study mode: On campus, Online
Campuses: Wagga Wagga, Orange
CRICOS code: 012345B
English language requirements: IELTS overall score of 6.0 with no band below 5.5
Entry requirements
To be eligible you need an ATAR of 65 or completion of an equivalent qualification. International applicants require the equivalent of Australian Year 12.
Career opportunities
Graduates work as agronomists, farm consultants and agricultural researchers across Australia and internationally.
`;

describe("extractCourseFacts — labeled text ladder", () => {
  const f = extractCourseFacts(PAGE_TEXT, "<html></html>");
  it("duration", () => expect(f.duration).toMatch(/4 years full-time/i));
  it("intakes (months found near the label)", () => {
    expect(f.intakes).toMatch(/February/);
    expect(f.intakes).toMatch(/July/);
  });
  it("international tuition fee with currency", () => expect(f.tuition_fee_international).toMatch(/AUD \$34,800/));
  it("application deadline date", () => expect(f.application_deadline).toMatch(/30 November 2026/i));
  it("study mode list", () => expect(f.study_mode).toMatch(/full-time|on-campus|online/));
  it("CRICOS code", () => expect(f.cricos_code).toBe("012345B"));
  it("IELTS requirement", () => expect(f.english_requirement).toMatch(/IELTS.*6\.0/i));
  it("eligibility snippet from the entry-requirements section", () =>
    expect(f.eligibility_snippet).toMatch(/ATAR of 65/i));
  it("benefits snippet from career opportunities", () => expect(f.benefits).toMatch(/agronomists/i));
});

describe("extractCourseFacts — JSON-LD wins per field", () => {
  const html = `<html><script type="application/ld+json">{
    "@context": "https://schema.org", "@type": "Course", "name": "Master of Data Science",
    "timeToComplete": "P2Y",
    "educationalProgramMode": "full-time",
    "offers": { "@type": "Offer", "price": "41000", "priceCurrency": "AUD" }
  }</script></html>`;
  const f = extractCourseFacts("Duration: 3 years part-time", html);
  it("JSON-LD duration (ISO humanized) beats the text value", () => expect(f.duration).toBe("2 years"));
  it("JSON-LD offer becomes the fee", () => expect(f.tuition_fee_international).toBe("AUD 41000"));
});

describe("extractCourseFacts — real-page defects (CSU regression)", () => {
  // Shape of study.csu.edu.au course pages: a TAB-STRIP repeats every section
  // label before the real content sections appear further down the page.
  const CSU_LIKE = `
Master of Leadership (Policing and Security)
Why study with us? Career opportunities What you will study Costs Entry requirements How to Apply Save to compare Key information Study mode and sessions Online Next session start: July 13, 2026 View all start dates & locations Duration Minimum time - 1.5 year(s)
Some more page furniture here.
Entry requirements
To be considered for admission you must hold a bachelor degree in a related discipline from a recognised institution, or equivalent professional experience of five years in policing or security management roles.
Career opportunities
Graduates lead investigation teams, security operations and intelligence units across government and the private sector, with strong demand in Australia.
Campuses: Bathurst, Port Macquarie
`;
  const f = extractCourseFacts(CSU_LIKE, "<html></html>");
  it("skips the tab-strip and captures the REAL entry-requirements section", () => {
    expect(f.eligibility_snippet).toMatch(/bachelor degree in a related discipline/i);
    expect(f.eligibility_snippet).not.toMatch(/save to compare/i);
  });
  it("skips the tab-strip and captures the REAL career section", () => {
    expect(f.benefits).toMatch(/investigation teams/i);
    expect(f.benefits).not.toMatch(/save to compare/i);
  });
  it("reads intakes from 'Next session start: July 13, 2026'", () => {
    expect(f.intakes).toMatch(/July/);
  });
  it("campus junk ('These…') is rejected; real place lists pass", () => {
    expect(f.campus).toMatch(/Bathurst/);
    const junk = extractCourseFacts("Campuses: These are listed on our locations page.", "<html></html>");
    expect(junk.campus).toBeUndefined();
  });
});

describe("extractCourseFacts — determinism + absence", () => {
  it("same input twice → identical output", () => {
    const a = extractCourseFacts(PAGE_TEXT, "<html></html>");
    const b = extractCourseFacts(PAGE_TEXT, "<html></html>");
    expect(a).toEqual(b);
  });
  it("missing facts stay absent (never guessed)", () => {
    const f = extractCourseFacts("Welcome to our university news page.", "<html></html>");
    expect(f.tuition_fee_international).toBeUndefined();
    expect(f.cricos_code).toBeUndefined();
    expect(f.application_deadline).toBeUndefined();
  });
});
