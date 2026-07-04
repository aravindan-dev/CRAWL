import { describe, it, expect } from "vitest";
import { yearEditionKey, createYearEditionGate } from "./yearEditions.js";

describe("yearEditionKey", () => {
  it("normalizes a year path segment into a family key", () => {
    const a = yearEditionKey("https://handbook.csu.edu.au/course/2025/BSC-NURS");
    const b = yearEditionKey("https://handbook.csu.edu.au/course/2023/BSC-NURS");
    expect(a).not.toBeNull();
    expect(a!.key).toBe(b!.key);
    expect(a!.year).toBe(2025);
    expect(b!.year).toBe(2023);
  });

  it("returns null when there is no whole year segment", () => {
    expect(yearEditionKey("https://study.csu.edu.au/international/courses/master-paramedicine")).toBeNull();
    // year-like digits inside a longer segment are NOT a year edition
    expect(yearEditionKey("https://ex.edu/courses/cs2025-intro")).toBeNull();
    expect(yearEditionKey("not a url")).toBeNull();
  });

  it("different courses in the same year stay distinct families", () => {
    const a = yearEditionKey("https://h.edu/course/2025/BSC-NURS")!;
    const b = yearEditionKey("https://h.edu/course/2025/BA-HIST")!;
    expect(a.key).not.toBe(b.key);
  });
});

describe("createYearEditionGate", () => {
  it("keeps the first (newest-so-far) edition and skips older ones", () => {
    const g = createYearEditionGate();
    expect(g.shouldSkip("https://h.edu/course/2026/BSC-NURS")).toBe(false); // newest first
    expect(g.shouldSkip("https://h.edu/course/2025/BSC-NURS")).toBe(true);
    expect(g.shouldSkip("https://h.edu/course/2023/BSC-NURS")).toBe(true);
  });

  it("lets a NEWER edition through even after an older one was kept", () => {
    const g = createYearEditionGate();
    expect(g.shouldSkip("https://h.edu/course/2024/BSC-NURS")).toBe(false);
    expect(g.shouldSkip("https://h.edu/course/2026/BSC-NURS")).toBe(false); // newer → crawl
    expect(g.shouldSkip("https://h.edu/course/2024/BSC-NURS")).toBe(true);
  });

  it("skips a same-year duplicate", () => {
    const g = createYearEditionGate();
    expect(g.shouldSkip("https://h.edu/course/2026/BSC-NURS")).toBe(false);
    expect(g.shouldSkip("https://h.edu/course/2026/BSC-NURS")).toBe(true);
  });

  it("never skips URLs without a year segment", () => {
    const g = createYearEditionGate();
    expect(g.shouldSkip("https://study.csu.edu.au/international/courses/a")).toBe(false);
    expect(g.shouldSkip("https://study.csu.edu.au/international/courses/a")).toBe(false);
  });

  it("seed() records visited editions so a resume skips older siblings", () => {
    const g = createYearEditionGate();
    g.seed("https://h.edu/course/2026/BSC-NURS"); // crawled last run
    expect(g.shouldSkip("https://h.edu/course/2024/BSC-NURS")).toBe(true);
    expect(g.shouldSkip("https://h.edu/course/2027/BSC-NURS")).toBe(false); // newer still allowed
  });

  it("tracks families independently", () => {
    const g = createYearEditionGate();
    expect(g.shouldSkip("https://h.edu/course/2026/BSC-NURS")).toBe(false);
    expect(g.shouldSkip("https://h.edu/course/2026/BA-HIST")).toBe(false);
  });

  it("bulk observe → filter keeps ONLY the newest edition even oldest-first", () => {
    const g = createYearEditionGate();
    const urls = [2023, 2024, 2025, 2026, 2027].map((y) => `https://h.edu/course/${y}/BSC-NURS`);
    for (const u of urls) g.observe(u); // sitemap/resume pre-pass
    const kept = urls.filter((u) => !g.shouldSkip(u));
    expect(kept).toEqual(["https://h.edu/course/2027/BSC-NURS"]);
  });

  it("observe alone never blocks a family's newest edition", () => {
    const g = createYearEditionGate();
    g.observe("https://h.edu/course/2027/BSC-NURS");
    expect(g.shouldSkip("https://h.edu/course/2027/BSC-NURS")).toBe(false);
  });
});
