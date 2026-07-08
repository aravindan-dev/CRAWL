import { describe, it, expect } from "vitest";
import { getMachineFingerprint } from "./fingerprint.js";

describe("getMachineFingerprint", () => {
  it("is a deterministic 32-char hex string on this machine", () => {
    const a = getMachineFingerprint();
    const b = getMachineFingerprint();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});
