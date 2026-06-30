import { describe, it, expect } from "vitest";
import { scoreLink, dispositionFor } from "./linkScorer.js";
import { filterLink } from "./linkFilters.js";
import { isPaginationLink } from "./pagination.js";

const base = "https://www.example.edu";

describe("scoreLink", () => {
  it("scores eligibility/admission pages highly", () => {
    const r = scoreLink({ url: `${base}/admissions/eligibility`, anchorText: "Eligibility", baseUrl: base });
    expect(r.score).toBeGreaterThanOrEqual(40);
  });

  it("gives same-domain + shallow-depth bonuses", () => {
    const r = scoreLink({ url: `${base}/study`, anchorText: "Study", baseUrl: base });
    expect(r.matched).toContain("same-domain");
    expect(r.matched).toContain("shallow-depth");
  });
});

describe("dispositionFor", () => {
  it("queues for extraction at/above the threshold", () => {
    expect(dispositionFor(45, 40)).toBe("EXTRACT");
    expect(dispositionFor(25, 40)).toBe("DISCOVER_ONLY");
    expect(dispositionFor(5, 40)).toBe("SKIP");
  });
});

describe("filterLink", () => {
  it("defers PDFs rather than dropping them", () => {
    const r = filterLink(`${base}/prospectus.pdf`);
    expect(r.isPdf).toBe(true);
    expect(r.rejected).toBe(true);
  });
  it("rejects login/privacy/social", () => {
    expect(filterLink(`${base}/login`).rejected).toBe(true);
    expect(filterLink(`${base}/privacy`).rejected).toBe(true);
    expect(filterLink("https://facebook.com/x").rejected).toBe(true);
  });
});

describe("isPaginationLink", () => {
  it("detects ?page= and next anchors", () => {
    expect(isPaginationLink(`${base}/courses?page=2`)).toBe(true);
    expect(isPaginationLink(`${base}/courses`, "Next")).toBe(true);
    expect(isPaginationLink(`${base}/about`, "About")).toBe(false);
  });
});
