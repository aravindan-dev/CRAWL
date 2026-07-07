import { describe, it, expect } from "vitest";
import { machineFingerprint, verifyLicense } from "./license.js";

describe("machineFingerprint", () => {
  it("is a deterministic 24-char hex string on this machine", () => {
    const a = machineFingerprint();
    const b = machineFingerprint();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("verifyLicense", () => {
  it("rejects malformed tokens without throwing", () => {
    expect(verifyLicense("").valid).toBe(false);
    expect(verifyLicense("not-a-license").valid).toBe(false);
    expect(verifyLicense("CLG1.onlytwoparts").valid).toBe(false);
    expect(verifyLicense("CLG1.a.b.c").valid).toBe(false);
  });

  it("rejects a syntactically valid but unsigned/forged token", () => {
    const fakePayload = Buffer.from(JSON.stringify({ company: "x", issued: "2026-01-01", expires: null, machine: "*", plan: "standard", features: [], seats: 1 })).toString("base64url");
    const r = verifyLicense(`CLG1.${fakePayload}.notarealsignature`);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/signature/i);
  });
});
