import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import { signLicense, verifyLicense } from "./crypto.js";
import { LicenseError } from "./errors.js";
import type { LicensePayload } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function makePayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    schema: 1,
    productId: "clg-search",
    edition: "server",
    licenseId: "11111111-1111-1111-1111-111111111111",
    customerName: "Acme Corp",
    customerEmail: "ops@acme.test",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(),
    maxUniversities: null,
    maxUsers: null,
    machineFingerprint: null,
    ...overrides,
  };
}

describe("signLicense / verifyLicense round-trip", () => {
  it("verifies a freshly signed license", () => {
    const payload = makePayload();
    const key = signLicense(payload, privateKeyPem);
    const verified = verifyLicense(key, publicKeyPem);
    expect(verified).toEqual(payload);
  });

  it("rejects a tampered payload", () => {
    const payload = makePayload();
    const key = signLicense(payload, privateKeyPem);
    const lines = key.split("\n");
    const [payloadB64, sigB64] = lines[1]!.split(".");
    const corrupted = [lines[0], `${payloadB64}x.${sigB64}`, lines[2]].join("\n");
    try {
      verifyLicense(corrupted, publicKeyPem);
      expect.fail("expected verifyLicense to throw");
    } catch (err) {
      expect((err as LicenseError).code).toBe("LICENSE_INVALID_SIGNATURE");
    }
  });

  it("rejects a signature from the wrong key", () => {
    const payload = makePayload();
    const key = signLicense(payload, privateKeyPem);
    const { publicKey: otherPub } = generateKeyPairSync("ed25519");
    const otherPem = otherPub.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyLicense(key, otherPem)).toThrow(LicenseError);
    try {
      verifyLicense(key, otherPem);
    } catch (err) {
      expect((err as LicenseError).code).toBe("LICENSE_INVALID_SIGNATURE");
    }
  });

  it("rejects malformed input without throwing an unrelated error", () => {
    expect(() => verifyLicense("")).toThrow(LicenseError);
    expect(() => verifyLicense("not-a-license")).toThrow(LicenseError);
  });

  it("rejects a license issued for a different product", () => {
    const payload = makePayload({ productId: "other-product" as LicensePayload["productId"] });
    const key = signLicense(payload, privateKeyPem);
    try {
      verifyLicense(key, publicKeyPem);
      expect.fail("expected verifyLicense to throw");
    } catch (err) {
      expect((err as LicenseError).code).toBe("LICENSE_WRONG_PRODUCT");
    }
  });
});
