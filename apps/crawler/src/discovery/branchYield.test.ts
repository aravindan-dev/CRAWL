import { describe, it, expect } from "vitest";
import { branchKey, createBranchYield } from "./branchYield.js";

describe("branchKey", () => {
  it("returns the first path segment, lowercased", () => {
    expect(branchKey("https://ex.edu/News/2024/story")).toBe("news");
    expect(branchKey("https://ex.edu/courses/bsc-nursing")).toBe("courses");
  });
  it("returns '/' for root or opaque URLs", () => {
    expect(branchKey("https://ex.edu/")).toBe("/");
    expect(branchKey("https://ex.edu")).toBe("/");
    expect(branchKey("not-a-url")).toBe("/");
  });
});

describe("createBranchYield", () => {
  it("does not mark a branch dead before the threshold", () => {
    const by = createBranchYield({ minPages: 5 });
    for (let i = 0; i < 4; i++) by.record(`https://ex.edu/news/${i}`, false);
    expect(by.isDead("https://ex.edu/news/x")).toBe(false);
  });

  it("marks a zero-target branch dead once it crosses the threshold", () => {
    const by = createBranchYield({ minPages: 5 });
    for (let i = 0; i < 5; i++) by.record(`https://ex.edu/news/${i}`, false);
    expect(by.isDead("https://ex.edu/news/x")).toBe(true);
    expect(by.deadBranches()).toContain("news");
  });

  it("never marks a productive branch dead, even past the threshold", () => {
    const by = createBranchYield({ minPages: 3 });
    by.record("https://ex.edu/courses/a", true); // one validated target
    for (let i = 0; i < 20; i++) by.record(`https://ex.edu/courses/${i}`, false);
    expect(by.isDead("https://ex.edu/courses/z")).toBe(false);
  });

  it("a later validated target revives a previously-dead branch", () => {
    const by = createBranchYield({ minPages: 3 });
    for (let i = 0; i < 3; i++) by.record(`https://ex.edu/study/${i}`, false);
    expect(by.isDead("https://ex.edu/study/x")).toBe(true);
    by.record("https://ex.edu/study/found-a-course", true);
    expect(by.isDead("https://ex.edu/study/x")).toBe(false);
  });

  it("never prunes the root branch", () => {
    const by = createBranchYield({ minPages: 1 });
    for (let i = 0; i < 50; i++) by.record("https://ex.edu/", false);
    expect(by.isDead("https://ex.edu/")).toBe(false);
    expect(by.deadBranches()).not.toContain("/");
  });

  it("tracks branches independently", () => {
    const by = createBranchYield({ minPages: 3 });
    for (let i = 0; i < 5; i++) by.record(`https://ex.edu/news/${i}`, false);
    by.record("https://ex.edu/courses/a", true);
    expect(by.isDead("https://ex.edu/news/x")).toBe(true);
    expect(by.isDead("https://ex.edu/courses/x")).toBe(false);
  });
});
