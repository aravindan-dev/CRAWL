import { describe, it, expect } from "vitest";
import {
  canonicalizeUrl,
  hashUrl,
  resolveUrl,
  isPdfUrl,
  isDroppedFileType,
  urlDepth,
} from "./canonicalize.js";

describe("canonicalizeUrl", () => {
  it("removes UTM and tracking params", () => {
    const out = canonicalizeUrl(
      "https://Example.edu/Admissions?utm_source=x&utm_medium=y&fbclid=z&page=2",
    );
    expect(out).toBe("https://example.edu/Admissions?page=2");
  });

  it("removes fragments", () => {
    expect(canonicalizeUrl("https://example.edu/a/b#section")).toBe(
      "https://example.edu/a/b",
    );
  });

  it("normalizes trailing slash but keeps root", () => {
    expect(canonicalizeUrl("https://example.edu/a/b/")).toBe(
      "https://example.edu/a/b",
    );
    expect(canonicalizeUrl("https://example.edu/")).toBe("https://example.edu/");
  });

  it("lowercases the hostname only (not the path)", () => {
    expect(canonicalizeUrl("https://EXAMPLE.edu/CaseSensitive")).toBe(
      "https://example.edu/CaseSensitive",
    );
  });

  it("sorts remaining query params for stable hashing", () => {
    const a = canonicalizeUrl("https://example.edu/x?b=2&a=1");
    const b = canonicalizeUrl("https://example.edu/x?a=1&b=2");
    expect(a).toBe(b);
  });
});

describe("hashUrl", () => {
  it("is a 64-char hex SHA-256 of the canonical form", () => {
    const h = hashUrl("https://example.edu/a/?utm_source=x");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).toBe(hashUrl("https://example.edu/a"));
  });
});

describe("resolveUrl", () => {
  it("resolves relative paths", () => {
    expect(resolveUrl("../courses", "https://example.edu/admissions/index")).toBe(
      "https://example.edu/courses",
    );
  });
  it("rejects mailto/tel/javascript/fragment", () => {
    const base = "https://example.edu";
    expect(resolveUrl("mailto:a@b.com", base)).toBeNull();
    expect(resolveUrl("tel:+1", base)).toBeNull();
    expect(resolveUrl("javascript:void(0)", base)).toBeNull();
    expect(resolveUrl("#top", base)).toBeNull();
  });
});

describe("file-type helpers", () => {
  it("detects PDFs", () => {
    expect(isPdfUrl("https://example.edu/prospectus.pdf")).toBe(true);
    expect(isPdfUrl("https://example.edu/page")).toBe(false);
  });
  it("detects dropped asset types", () => {
    expect(isDroppedFileType("https://example.edu/a.jpg")).toBe(true);
    expect(isDroppedFileType("https://example.edu/a.pdf")).toBe(false); // PDFs deferred, not dropped
  });
});

describe("urlDepth", () => {
  it("counts non-empty path segments", () => {
    expect(urlDepth("https://example.edu")).toBe(0);
    expect(urlDepth("https://example.edu/a/b/c")).toBe(3);
  });
});
