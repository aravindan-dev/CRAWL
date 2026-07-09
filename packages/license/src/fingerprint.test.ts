import { describe, it, expect } from "vitest";
import { getMachineFingerprint, getFingerprintCandidates } from "./fingerprint.js";

describe("getMachineFingerprint", () => {
  it("is a deterministic 32-char hex string on this machine", () => {
    const a = getMachineFingerprint();
    const b = getMachineFingerprint();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("getFingerprintCandidates", () => {
  it("always includes the primary fingerprint and only 32-hex values", () => {
    const c = getFingerprintCandidates();
    expect(c.size).toBeGreaterThan(0);
    expect(c.has(getMachineFingerprint())).toBe(true);
    for (const v of c) expect(v).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic across calls (same machine → same candidate set)", () => {
    const a = [...getFingerprintCandidates()].sort();
    const b = [...getFingerprintCandidates()].sort();
    expect(a).toEqual(b);
  });

  it("never contains a foreign fingerprint", () => {
    // A different machine's identities are disjoint from this machine's, so the
    // permissive candidate set must not accept an arbitrary/foreign value.
    expect(getFingerprintCandidates().has("deadbeefdeadbeefdeadbeefdeadbeef")).toBe(false);
  });
});
