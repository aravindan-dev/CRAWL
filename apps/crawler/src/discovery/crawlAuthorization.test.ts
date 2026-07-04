/**
 * Regression tests for STRICT CRAWL-CONTEXT ISOLATION (the non-negotiable
 * requirement): classification + authorization happen BEFORE fetch, cross-
 * context URLs are rejected pre-network, and a high relevance score can never
 * override the policy.
 */
import { describe, it, expect } from "vitest";
import { CrawlContext, PageClass, canonicalizeUrl, contextsForTarget } from "@clg/shared";
import { classifyUrl } from "./urlClassifier.js";
import { gateUrl, authorizeFetch } from "./crawlAuthorization.js";
import { scoreLink } from "./linkScorer.js";
import { canonicalCourseUrl } from "../export/courseUrl.js";

const base = "https://www.example.edu";

describe("classifyUrl (pre-fetch, deterministic)", () => {
  it("classifies individual course pages", () => {
    expect(classifyUrl({ url: `${base}/courses/computer-science-bsc` }).pageClass).toBe(PageClass.COURSE_PAGE);
    expect(classifyUrl({ url: `${base}/study/bachelor-of-nursing` }).pageClass).toBe(PageClass.COURSE_PAGE);
  });
  it("classifies course listings/finders separately from courses", () => {
    expect(classifyUrl({ url: `${base}/courses` }).pageClass).toBe(PageClass.COURSE_LISTING);
    expect(classifyUrl({ url: `${base}/courses/undergraduate` }).pageClass).toBe(PageClass.COURSE_LISTING);
    expect(classifyUrl({ url: `${base}/study/course-finder` }).pageClass).toBe(PageClass.COURSE_LISTING);
  });
  it("classifies general eligibility / admissions / international pages", () => {
    expect(classifyUrl({ url: `${base}/entry-requirements` }).pageClass).toBe(PageClass.ELIGIBILITY_PAGE);
    expect(classifyUrl({ url: `${base}/admissions` }).pageClass).toBe(PageClass.ADMISSIONS_PAGE);
    expect(classifyUrl({ url: `${base}/international/entry-requirements` }).pageClass).toBe(
      PageClass.INTERNATIONAL_ADMISSIONS_PAGE,
    );
  });
  it("uses anchor text when the URL is opaque ('Check eligibility' button)", () => {
    const r = classifyUrl({ url: `${base}/pages/xyz123`, anchorText: "Check eligibility" });
    expect(r.pageClass).toBe(PageClass.ELIGIBILITY_PAGE);
  });
  it("classifies scholarship pages and listings", () => {
    expect(classifyUrl({ url: `${base}/scholarships/vice-chancellors-international-award` }).pageClass).toBe(
      PageClass.SCHOLARSHIP_PAGE,
    );
    expect(classifyUrl({ url: `${base}/scholarships` }).pageClass).toBe(PageClass.SCHOLARSHIP_LISTING);
    expect(classifyUrl({ url: `${base}/funding` }).pageClass).toBe(PageClass.FUNDING_PAGE);
  });
  it("keeps a scholarship's own eligibility tab in the scholarship scope (path wins)", () => {
    const r = classifyUrl({ url: `${base}/scholarships/global-excellence/eligibility`, anchorText: "Eligibility" });
    expect(r.pageClass).toBe(PageClass.SCHOLARSHIP_PAGE);
  });
  it("classifies documents and irrelevant paths", () => {
    expect(classifyUrl({ url: `${base}/prospectus.pdf` }).pageClass).toBe(PageClass.DOCUMENT);
    expect(classifyUrl({ url: `${base}/login` }).pageClass).toBe(PageClass.IRRELEVANT);
  });
});

describe("authorizeFetch — the cross-context policy", () => {
  const eligClasses = [
    PageClass.COURSE_PAGE,
    PageClass.COURSE_LISTING,
    PageClass.ELIGIBILITY_PAGE,
    PageClass.ADMISSIONS_PAGE,
    PageClass.INTERNATIONAL_ADMISSIONS_PAGE,
  ] as const;
  const schClasses = [PageClass.SCHOLARSHIP_PAGE, PageClass.SCHOLARSHIP_LISTING, PageClass.FUNDING_PAGE] as const;

  it("SCHOLARSHIP crawls never fetch eligibility/admissions/course/programme pages", () => {
    for (const cls of eligClasses) {
      const d = authorizeFetch(cls, CrawlContext.SCHOLARSHIP);
      expect(d.allowed).toBe(false);
      expect(d.crossContext).toBe(true);
    }
  });
  it("ELIGIBILITY crawls never fetch scholarship/funding pages", () => {
    for (const cls of schClasses) {
      const d = authorizeFetch(cls, CrawlContext.ELIGIBILITY);
      expect(d.allowed).toBe(false);
      expect(d.crossContext).toBe(true);
    }
  });
  it("each context may fetch its own targets plus navigation/unknown discovery pages", () => {
    for (const cls of eligClasses) expect(authorizeFetch(cls, CrawlContext.ELIGIBILITY).allowed).toBe(true);
    for (const cls of schClasses) expect(authorizeFetch(cls, CrawlContext.SCHOLARSHIP).allowed).toBe(true);
    for (const ctx of [CrawlContext.ELIGIBILITY, CrawlContext.SCHOLARSHIP]) {
      expect(authorizeFetch(PageClass.NAVIGATION_PAGE, ctx).allowed).toBe(true);
      expect(authorizeFetch(PageClass.UNKNOWN, ctx).allowed).toBe(true);
    }
  });
  it("documents and irrelevant pages are never fetched (not cross-context)", () => {
    for (const ctx of [CrawlContext.ELIGIBILITY, CrawlContext.SCHOLARSHIP]) {
      for (const cls of [PageClass.DOCUMENT, PageClass.IRRELEVANT]) {
        const d = authorizeFetch(cls, ctx);
        expect(d.allowed).toBe(false);
        expect(d.crossContext).toBe(false);
      }
    }
  });
});

describe("Scenario 1+2: scholarship page discovers eligibility / course links", () => {
  it("rejects a 'Check eligibility' link before fetch", () => {
    const g = gateUrl(
      { url: `${base}/admissions/entry-requirements`, anchorText: "Check eligibility", parentUrl: `${base}/scholarships/deans-award` },
      CrawlContext.SCHOLARSHIP,
    );
    expect(g.decision.allowed).toBe(false);
    expect(g.decision.crossContext).toBe(true);
  });
  it("rejects a 'Find your course' link before fetch", () => {
    const g = gateUrl(
      { url: `${base}/courses/mechanical-engineering-beng`, anchorText: "View programme" },
      CrawlContext.SCHOLARSHIP,
    );
    expect(g.decision.allowed).toBe(false);
    expect(g.decision.crossContext).toBe(true);
    expect(g.classification.pageClass).toBe(PageClass.COURSE_PAGE);
  });
  it("rejects an 'International requirements' link before fetch", () => {
    const g = gateUrl({ url: `${base}/international/admission-requirements` }, CrawlContext.SCHOLARSHIP);
    expect(g.decision.allowed).toBe(false);
    expect(g.decision.crossContext).toBe(true);
  });
});

describe("Scenario 3: eligibility crawl discovers scholarship links", () => {
  it("rejects scholarship/funding/bursary links before fetch", () => {
    for (const url of [`${base}/scholarships/international-merit`, `${base}/funding`, `${base}/bursaries/hardship`]) {
      const g = gateUrl({ url, anchorText: "Scholarships and funding" }, CrawlContext.ELIGIBILITY);
      expect(g.decision.allowed, url).toBe(false);
      expect(g.decision.crossContext, url).toBe(true);
    }
  });
});

describe("Scenario 9: fifty eligibility links in one scholarship crawl — all rejected pre-fetch", () => {
  it("rejects every one of 50 eligibility links (expected network requests: 0)", () => {
    const urls = Array.from({ length: 50 }, (_, i) => `${base}/admissions/entry-requirements/page-${i}`);
    let rejected = 0;
    for (const url of urls) {
      const g = gateUrl({ url, anchorText: "Entry requirements" }, CrawlContext.SCHOLARSHIP);
      if (!g.decision.allowed && g.decision.crossContext) rejected += 1;
    }
    expect(rejected).toBe(50);
  });
});

describe("link score can NEVER override a cross-context rejection", () => {
  it("a maximum-relevance eligibility URL is still refused in a scholarship crawl", () => {
    const url = `${base}/international/entry-requirements`;
    // Even scored under the ELIGIBILITY weighting this URL is highly relevant…
    const eligScore = scoreLink({ url, anchorText: "International Eligibility Requirements", baseUrl: base, context: CrawlContext.ELIGIBILITY });
    expect(eligScore.score).toBeGreaterThanOrEqual(60);
    // …but authorization (which runs FIRST) refuses it in the scholarship context.
    const g = gateUrl({ url, anchorText: "International Eligibility Requirements" }, CrawlContext.SCHOLARSHIP);
    expect(g.decision.allowed).toBe(false);
    expect(g.decision.crossContext).toBe(true);
  });
});

describe("Scenario 11: resume/recovery re-passes the same gate", () => {
  it("a stale frontier of mixed URLs only re-seeds in-context ones", () => {
    const staleFrontier = [
      `${base}/courses/data-science-msc`, // course page — eligibility only
      `${base}/scholarships/international-excellence-award`, // scholarship — scholarship only
      `${base}/study`, // navigation — both
    ];
    const allowedInScholarship = staleFrontier.filter((u) => gateUrl({ url: u }, CrawlContext.SCHOLARSHIP).decision.allowed);
    expect(allowedInScholarship).toEqual([`${base}/scholarships/international-excellence-award`, `${base}/study`]);
    const allowedInEligibility = staleFrontier.filter((u) => gateUrl({ url: u }, CrawlContext.ELIGIBILITY).decision.allowed);
    expect(allowedInEligibility).toEqual([`${base}/courses/data-science-msc`, `${base}/study`]);
  });
});

describe("Scenario 8: fragment variants collapse to ONE canonical course target", () => {
  it("overview/entry-requirements/eligibility/fees anchors share one canonical URL", () => {
    const canon = new Set(
      ["#overview", "#course-details", "#entry-requirements", "#eligibility", "#fees", ""].map((frag) =>
        canonicalizeUrl(`${base}/courses/computer-science-bsc${frag}`),
      ),
    );
    expect(canon.size).toBe(1);
    const courseCanon = new Set(
      ["#overview", "#entry-requirements", ""].map((frag) => canonicalCourseUrl(`${base}/courses/computer-science-bsc${frag}`)),
    );
    expect(courseCanon.size).toBe(1);
  });
});

describe("contextsForTarget — one context per crawl execution", () => {
  it("'both' runs TWO separate executions, never one mixed crawl", () => {
    expect(contextsForTarget("both")).toEqual([CrawlContext.ELIGIBILITY, CrawlContext.SCHOLARSHIP]);
    expect(contextsForTarget("eligibility")).toEqual([CrawlContext.ELIGIBILITY]);
    expect(contextsForTarget("scholarship")).toEqual([CrawlContext.SCHOLARSHIP]);
  });
});
