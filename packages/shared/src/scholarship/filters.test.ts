import { describe, it, expect } from "vitest";
import { rejectScholarship, SCH_CONTAINER_END } from "./filters.js";

describe("SCH_CONTAINER_END / rejectScholarship — category & facet pages", () => {
  it("rejects audience/degree-level facet pages with a file extension (real-world bug: sydney.edu.au)", () => {
    const facultyUrl = "https://www.sydney.edu.au/scholarships/domestic/postgraduate-research/faculty.html";
    const generalUrl = "https://www.sydney.edu.au/scholarships/domestic/postgraduate-research/general.html";
    expect(SCH_CONTAINER_END.test(new URL(facultyUrl).pathname)).toBe(true);
    expect(SCH_CONTAINER_END.test(new URL(generalUrl).pathname)).toBe(true);
    expect(rejectScholarship(facultyUrl, "")).toBe("category/listing page");
    expect(rejectScholarship(generalUrl, "")).toBe("category/listing page");
  });

  it("still rejects extension-less container/listing pages (pre-existing behavior)", () => {
    expect(rejectScholarship("https://example.edu/find-scholarship/foundation/any-year", "")).toBe("category/listing page");
    expect(rejectScholarship("https://example.edu/scholarships/equity", "")).toBe("category/listing page");
  });

  it("does NOT reject a real, individually-named scholarship page", () => {
    const url = "https://www.sydney.edu.au/scholarships/c/the-western-nsw-local-health-district-scholarship-for-graduate-c.html";
    expect(rejectScholarship(url, "")).toBeNull();
  });

  it("does not reject a course slug that merely ends in a shared container word", () => {
    // "-research" as part of a real degree slug must not collide with the bare
    // "research" container-end word (container match requires the ENTIRE final
    // path segment to be the word, not merely end with it).
    expect(SCH_CONTAINER_END.test("/courses/masters-of-research")).toBe(false);
  });
});
