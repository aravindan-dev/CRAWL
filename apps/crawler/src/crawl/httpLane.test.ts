import { describe, it, expect } from "vitest";
import {
  extractFromHtml,
  assessFastFetch,
  looksLikeDynamicFinder,
  parseRobotsTxt,
  robotsAllows,
  type HttpFetchResult,
} from "./httpLane.js";

const PAGE = "https://study.ex.edu/courses/bsc-nursing";

const COURSE_HTML = `
<html lang="en"><head><title>Bachelor of Nursing - Ex University</title></head>
<body><main>
  <h1>Bachelor of Nursing</h1>
  <p>Prepare for clinical practice with our accredited nursing degree.</p>
  <h2>Entry requirements</h2>
  <p>International students require IELTS 6.5 with no band below 6.0.</p>
  <ul><li>Senior secondary certificate</li><li>Chemistry prerequisite</li></ul>
  <a href="/courses/bsc-nursing/apply">Apply now</a>
  <a href="https://study.ex.edu/courses/ba-history">BA History</a>
</main></body></html>`;

describe("extractFromHtml", () => {
  it("extracts title, headings, text and resolved internal links", () => {
    const p = extractFromHtml(COURSE_HTML, PAGE, PAGE);
    expect(p.page_title).toBe("Bachelor of Nursing - Ex University");
    expect(p.visible_text).toContain("IELTS 6.5");
    expect(p.visible_text).toContain("Entry requirements");
    expect(p.headings.some((h) => h.tag === "h2" && /entry requirements/i.test(h.text))).toBe(true);
    expect(p.internal_links).toContainEqual({ url: "https://study.ex.edu/courses/bsc-nursing/apply", text: "Apply now" });
    expect(p.internal_links).toContainEqual({ url: "https://study.ex.edu/courses/ba-history", text: "BA History" });
  });

  it("joins blocks with newlines (innerText-like, not one long line)", () => {
    const p = extractFromHtml(COURSE_HTML, PAGE, PAGE);
    expect(p.visible_text.split("\n").length).toBeGreaterThan(3);
  });

  it("falls back to h1 when the document title is junk", () => {
    const html = `<html><head><title>Error</title></head><body><h1>Master of Teaching</h1><p>x</p></body></html>`;
    expect(extractFromHtml(html, PAGE, PAGE).page_title).toBe("Master of Teaching");
  });

  it("strips script/style content from text", () => {
    const html = `<html><body><main><p>Real content</p><script>var secret=1;</script></main></body></html>`;
    const p = extractFromHtml(html, PAGE, PAGE);
    expect(p.visible_text).toContain("Real content");
    expect(p.visible_text).not.toContain("secret");
  });
});

describe("assessFastFetch", () => {
  const res = (over: Partial<HttpFetchResult>): HttpFetchResult => ({ ok: true, status: 200, finalUrl: PAGE, body: "<html></html>", ...over });

  it("serves a healthy content page fast", () => {
    expect(assessFastFetch(res({}), 2000)).toEqual({ serveFast: true });
  });

  it("escalates network failures", () => {
    expect(assessFastFetch(res({ ok: false, status: null }), 0)).toEqual({ serveFast: false, reason: "network" });
  });

  it("escalates bot challenges even with HTTP 200", () => {
    const a = assessFastFetch(res({ body: "<title>Just a moment...</title>" }), 2000);
    expect(a).toEqual({ serveFast: false, reason: "bot-challenge" });
  });

  it("escalates 403/429/503 (a browser may pass what plain fetch cannot)", () => {
    for (const s of [401, 403, 429, 503]) {
      expect(assessFastFetch(res({ status: s }), 2000).serveFast).toBe(false);
    }
  });

  it("serves plain 404s fast — a dead page needs no browser", () => {
    expect(assessFastFetch(res({ status: 404 }), 50)).toEqual({ serveFast: true });
  });

  it("escalates thin-content 200s (JS shell needing a real render)", () => {
    expect(assessFastFetch(res({}), 120)).toEqual({ serveFast: false, reason: "thin-content" });
  });
});

describe("looksLikeDynamicFinder", () => {
  it("detects DataTables and load-more affordances", () => {
    expect(looksLikeDynamicFinder('<select name="tbl_length"></select>')).toBe(true);
    expect(looksLikeDynamicFinder("<button>Load more results</button>")).toBe(true);
  });
  it("passes an ordinary course page", () => {
    expect(looksLikeDynamicFinder(COURSE_HTML)).toBe(false);
  });
});

describe("robots.txt parsing for the fast lane", () => {
  it("applies the User-agent: * group with longest-match semantics", () => {
    const rules = parseRobotsTxt("User-agent: *\nDisallow: /admin\nAllow: /admin/public\n\nUser-agent: FooBot\nDisallow: /");
    expect(robotsAllows(rules, "/courses/bsc")).toBe(true);
    expect(robotsAllows(rules, "/admin/secret")).toBe(false);
    expect(robotsAllows(rules, "/admin/public/page")).toBe(true);
  });

  it("supports * wildcards and $ anchors", () => {
    const rules = parseRobotsTxt("User-agent: *\nDisallow: /*?print=1\nDisallow: /tmp$");
    expect(robotsAllows(rules, "/courses/x?print=1")).toBe(false);
    expect(robotsAllows(rules, "/tmp")).toBe(false);
    expect(robotsAllows(rules, "/tmp/inner")).toBe(true);
  });

  it("allows everything when robots has no * group or is empty", () => {
    expect(robotsAllows(parseRobotsTxt("User-agent: FooBot\nDisallow: /"), "/anything")).toBe(true);
    expect(robotsAllows(parseRobotsTxt(""), "/anything")).toBe(true);
  });

  it("treats consecutive User-agent lines as one group", () => {
    const rules = parseRobotsTxt("User-agent: FooBot\nUser-agent: *\nDisallow: /private");
    expect(robotsAllows(rules, "/private/x")).toBe(false);
  });
});
