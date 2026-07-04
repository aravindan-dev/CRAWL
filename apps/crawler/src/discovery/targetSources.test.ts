import { describe, it, expect } from "vitest";
import { candidateTargetSources } from "./targetSources.js";
import { CrawlContext } from "@clg/shared";

describe("candidateTargetSources", () => {
  it("generates course catalogue/finder URLs for eligibility", () => {
    const urls = candidateTargetSources("https://www.example.ac.uk", CrawlContext.ELIGIBILITY);
    expect(urls.some((u) => /\/courses$/.test(u))).toBe(true);
    expect(urls.some((u) => /course-search/.test(u))).toBe(true);
    expect(urls.some((u) => /course-finder/.test(u))).toBe(true);
    expect(urls.some((u) => /\/degrees$/.test(u))).toBe(true);
  });

  it("probes academic subdomains for eligibility (study./courses./handbook.)", () => {
    const urls = candidateTargetSources("https://www.example.ac.uk", CrawlContext.ELIGIBILITY);
    expect(urls.some((u) => u.startsWith("https://study.example.ac.uk"))).toBe(true);
    expect(urls.some((u) => u.startsWith("https://handbook.example.ac.uk"))).toBe(true);
  });

  it("generates scholarship/funding directory URLs for scholarship", () => {
    const urls = candidateTargetSources("https://www.example.edu", CrawlContext.SCHOLARSHIP);
    expect(urls.some((u) => /\/scholarships$/.test(u))).toBe(true);
    expect(urls.some((u) => /scholarship-search/.test(u))).toBe(true);
    expect(urls.some((u) => /\/funding$/.test(u))).toBe(true);
  });

  it("does not probe academic catalogue subdomains for scholarship (avoids dead DNS)", () => {
    const urls = candidateTargetSources("https://www.example.edu", CrawlContext.SCHOLARSHIP);
    expect(urls.some((u) => u.startsWith("https://handbook."))).toBe(false);
    expect(urls.some((u) => u.startsWith("https://courses."))).toBe(false);
  });

  it("scholarship URLs never include course paths and vice-versa", () => {
    const sch = candidateTargetSources("https://www.example.edu", CrawlContext.SCHOLARSHIP);
    expect(sch.some((u) => /\/courses/.test(u))).toBe(false);
    const elig = candidateTargetSources("https://www.example.edu", CrawlContext.ELIGIBILITY);
    expect(elig.some((u) => /\/scholarships/.test(u))).toBe(false);
  });

  it("de-duplicates and respects the cap", () => {
    const urls = candidateTargetSources("https://example.edu", CrawlContext.ELIGIBILITY, 10);
    expect(urls.length).toBeLessThanOrEqual(10);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("returns [] for a malformed base url", () => {
    expect(candidateTargetSources("not a url", CrawlContext.ELIGIBILITY)).toEqual([]);
  });

  it("produces absolute, parseable URLs", () => {
    const urls = candidateTargetSources("https://www.example.ac.uk", CrawlContext.ELIGIBILITY);
    for (const u of urls) expect(() => new URL(u)).not.toThrow();
  });
});
