import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { resolveWithinRoot, EXPORTS_ROOT } from "./files.js";

describe("resolveWithinRoot", () => {
  it("resolves a plain filename inside the root", () => {
    expect(resolveWithinRoot(EXPORTS_ROOT, "eligibility-ALL-INTERNATIONAL-FINAL.csv")).toBe(
      join(EXPORTS_ROOT, "eligibility-ALL-INTERNATIONAL-FINAL.csv"),
    );
  });

  it("resolves a nested subdirectory path inside the root", () => {
    const resolved = resolveWithinRoot(EXPORTS_ROOT, "by-university/Acme.csv");
    expect(resolved).not.toBeNull();
    expect(resolved!.startsWith(EXPORTS_ROOT)).toBe(true);
  });

  it("rejects a traversal attempt that escapes the root", () => {
    expect(resolveWithinRoot(EXPORTS_ROOT, "../../etc/passwd")).toBeNull();
    expect(resolveWithinRoot(EXPORTS_ROOT, "..\\..\\Windows\\System32\\config")).toBeNull();
  });

  it("rejects an absolute path outside the root", () => {
    expect(resolveWithinRoot(EXPORTS_ROOT, "C:\\Windows\\System32\\config")).toBeNull();
  });
});
