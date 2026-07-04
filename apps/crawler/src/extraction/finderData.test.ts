import { describe, it, expect } from "vitest";
import { extractLinksFromJson } from "./finderData.js";

const PAGE = "https://study.example.ac.uk/course-search";

describe("extractLinksFromJson", () => {
  it("extracts absolute URLs from __NEXT_DATA__", () => {
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      { props: { pageProps: { courses: [{ url: "https://study.example.ac.uk/courses/bsc-nursing" }, { url: "https://study.example.ac.uk/courses/ba-history" }] } } },
    )}</script></body></html>`;
    const urls = extractLinksFromJson(html, PAGE);
    expect(urls).toContain("https://study.example.ac.uk/courses/bsc-nursing");
    expect(urls).toContain("https://study.example.ac.uk/courses/ba-history");
  });

  it("resolves root-relative hrefs against the page URL", () => {
    const html = `<script type="application/json">${JSON.stringify({
      results: [{ href: "/courses/meng-civil" }, { href: "/courses/msc-data-science" }],
    })}</script>`;
    const urls = extractLinksFromJson(html, PAGE);
    expect(urls).toContain("https://study.example.ac.uk/courses/meng-civil");
    expect(urls).toContain("https://study.example.ac.uk/courses/msc-data-science");
  });

  it("resolves bare slugs under url-ish keys", () => {
    const html = `<script type="application/json">${JSON.stringify({
      items: [{ slug: "bachelor-of-nursing" }, { permalink: "master-of-engineering" }],
    })}</script>`;
    const urls = extractLinksFromJson(html, "https://study.example.ac.uk/courses/");
    expect(urls).toContain("https://study.example.ac.uk/courses/bachelor-of-nursing");
    expect(urls).toContain("https://study.example.ac.uk/courses/master-of-engineering");
  });

  it("mines schema.org ld+json ItemList", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "ItemList",
      itemListElement: [
        { "@type": "ListItem", url: "https://example.edu/scholarships/vc-award" },
        { "@type": "ListItem", url: "https://example.edu/scholarships/global-merit" },
      ],
    })}</script>`;
    const urls = extractLinksFromJson(html, "https://example.edu/scholarships");
    expect(urls).toContain("https://example.edu/scholarships/vc-award");
    expect(urls).toContain("https://example.edu/scholarships/global-merit");
  });

  it("returns [] for html with no JSON islands", () => {
    expect(extractLinksFromJson("<html><body><h1>Courses</h1></body></html>", PAGE)).toEqual([]);
  });

  it("skips malformed JSON without throwing", () => {
    const html = `<script type="application/json">{ this is not valid json </script>`;
    expect(() => extractLinksFromJson(html, PAGE)).not.toThrow();
    expect(extractLinksFromJson(html, PAGE)).toEqual([]);
  });

  it("de-duplicates repeated URLs", () => {
    const html = `<script type="application/json">${JSON.stringify({
      a: [{ url: "/courses/x" }, { url: "/courses/x" }],
    })}</script>`;
    const urls = extractLinksFromJson(html, PAGE);
    expect(urls.filter((u) => u.endsWith("/courses/x")).length).toBe(1);
  });

  it("returns [] for empty input", () => {
    expect(extractLinksFromJson("", PAGE)).toEqual([]);
  });
});
