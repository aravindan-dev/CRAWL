import { describe, it, expect } from "vitest";
import { chunkSections } from "./sectionChunker.js";
import type { ContentBlock } from "@clg/shared";

const ctx = { source_url: "https://e.edu/x", page_title: "X", university_id: "u1" };

describe("chunkSections", () => {
  it("splits by heading and attaches following content", () => {
    const blocks: ContentBlock[] = [
      { type: "heading", level: 2, text: "Computer Science" },
      { type: "paragraph", text: "Entry requirements: minimum 75% overall average required." },
      { type: "heading", level: 2, text: "Mathematics" },
      { type: "paragraph", text: "Applicants need A-levels including Mathematics at grade A." },
    ];
    const sections = chunkSections(blocks, ctx);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.heading).toBe("Computer Science");
    expect(sections[0]!.body).toContain("75%");
    expect(sections[0]!.source_url).toBe("https://e.edu/x");
  });

  it("caps oversized bodies at <=6000 chars per chunk, repeating the heading", () => {
    const big = "x".repeat(9000);
    const blocks: ContentBlock[] = [
      { type: "heading", level: 1, text: "Big" },
      { type: "paragraph", text: big },
    ];
    const sections = chunkSections(blocks, ctx);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.body.length <= 6000)).toBe(true);
    expect(sections.every((s) => s.heading === "Big")).toBe(true);
  });

  it("preserves tables on the section", () => {
    const blocks: ContentBlock[] = [
      { type: "heading", level: 2, text: "Grades" },
      { type: "table", table: { caption: null, headers: ["Subject", "Min"], rows: [["Maths", "A"]] } },
    ];
    const [s] = chunkSections(blocks, ctx);
    expect(s!.tables).toHaveLength(1);
    expect(s!.tables[0]!.headers).toEqual(["Subject", "Min"]);
  });
});
