import { describe, it, expect } from "vitest";
import { keywordsToRegex } from "./keywords.js";

describe("keywordsToRegex — ASCII word-boundary guards", () => {
  it("does NOT match a short keyword as a bare substring of an unrelated word", () => {
    const re = keywordsToRegex(["grant", "grants"]);
    // Real bug: cookie-consent banner JS ("status === 'granted'") false-matched
    // "grant" as scholarship evidence because the old regex had no boundaries.
    expect(re.test('consentValue = 0; if (val && val.status === "granted") { consentValue = 1; }')).toBe(false);
    expect(re.test("grant_type=client_credentials")).toBe(false);
    expect(re.test("warranty and grantor details")).toBe(false);
  });

  it("still matches the keyword as a real standalone word", () => {
    const re = keywordsToRegex(["grant", "grants"]);
    expect(re.test("You may be eligible for a need-based grant.")).toBe(true);
    expect(re.test("International grants are available.")).toBe(true);
    expect(re.test("/scholarships/grants/graduate")).toBe(true);
  });

  it("matches multi-word phrases across space/hyphen/underscore variants", () => {
    const re = keywordsToRegex(["fee waiver", "how to apply"]);
    expect(re.test("a tuition fee waiver of $5,000")).toBe(true);
    expect(re.test("/fee-waiver-scheme")).toBe(true);
    expect(re.test("how_to_apply.html")).toBe(true);
    expect(re.test("feewaiverxyz")).toBe(false);
  });

  it("still matches multi-byte (CJK) keywords unaffected by the ASCII boundary guard", () => {
    const re = keywordsToRegex(["奖学金", "国际学生"]);
    expect(re.test("本页面介绍奖学金申请流程")).toBe(true);
    expect(re.test("面向国际学生的奖学金")).toBe(true);
  });

  it("is case-insensitive and still returns a usable exec().index for snippet extraction", () => {
    const re = keywordsToRegex(["eligibility criteria"]);
    const m = re.exec("Please review the ELIGIBILITY CRITERIA before applying.");
    expect(m).not.toBeNull();
    expect(m!.index).toBeGreaterThan(0);
  });

  it("empty list matches nothing", () => {
    const re = keywordsToRegex([]);
    expect(re.test("anything at all")).toBe(false);
  });
});
