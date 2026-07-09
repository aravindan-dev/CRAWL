import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { signLicense } from "./crypto.js";
import { getMachineFingerprint, getFingerprintCandidates } from "./fingerprint.js";
import { checkLicense, activateLicense, GRACE_PERIOD_DAYS } from "./verify.js";
import type { LicensePayload } from "./types.js";

const PRIVATE_KEY_PATH = fileURLToPath(
  new URL("../../../tools/license-admin/keys/private.pem", import.meta.url),
);

let privateKeyPem: string;
beforeAll(() => {
  privateKeyPem = readFileSync(PRIVATE_KEY_PATH, "utf8");
});

function makePayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    schema: 1,
    productId: "clg-search",
    edition: "server",
    licenseId: "22222222-2222-2222-2222-222222222222",
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

function freshStorageDir(): string {
  return mkdtempSync(join(tmpdir(), "clg-license-test-"));
}

describe("checkLicense", () => {
  it("reports LICENSE_MISSING with no license.key present", () => {
    const dir = freshStorageDir();
    expect(checkLicense(dir)).toEqual({ state: "invalid", code: "LICENSE_MISSING", message: expect.any(String) });
  });

  it("reports valid after activateLicense binds the key to this machine", () => {
    const dir = freshStorageDir();
    const payload = makePayload();
    const key = signLicense(payload, privateKeyPem);
    const status = activateLicense(dir, key);
    expect(status.state).toBe("valid");
    if (status.state === "valid") {
      expect(status.payload.licenseId).toBe(payload.licenseId);
    }
    expect(checkLicense(dir)).toEqual(status);
  });

  it("reports grace within 7 days past expiry, and invalid after", () => {
    const dir = freshStorageDir();
    const expiredPayload = makePayload({ expiresAt: new Date(Date.now() - 3 * 86400_000).toISOString() });
    const key = signLicense(expiredPayload, privateKeyPem);
    const status = activateLicense(dir, key);
    expect(status.state).toBe("grace");
    if (status.state === "grace") expect(status.graceDaysLeft).toBeLessThanOrEqual(GRACE_PERIOD_DAYS);

    const dir2 = freshStorageDir();
    const longExpiredPayload = makePayload({
      expiresAt: new Date(Date.now() - (GRACE_PERIOD_DAYS + 3) * 86400_000).toISOString(),
    });
    const key2 = signLicense(longExpiredPayload, privateKeyPem);
    const status2 = activateLicense(dir2, key2);
    expect(status2).toEqual({ state: "invalid", code: "LICENSE_EXPIRED", message: expect.any(String) });
  });

  it("reports LICENSE_MACHINE_MISMATCH when activation.json fingerprint diverges", () => {
    const dir = freshStorageDir();
    const payload = makePayload();
    const key = signLicense(payload, privateKeyPem);
    activateLicense(dir, key);
    writeFileSync(
      join(dir, "license", "activation.json"),
      JSON.stringify({ licenseId: payload.licenseId, fingerprint: "deadbeef", activatedAt: new Date().toISOString() }),
      "utf8",
    );
    const status = checkLicense(dir);
    expect(status).toEqual({ state: "invalid", code: "LICENSE_MACHINE_MISMATCH", message: expect.any(String) });
  });

  it("reports LICENSE_MACHINE_MISMATCH when activating a key bound to a different machine", () => {
    const dir = freshStorageDir();
    const payload = makePayload({ machineFingerprint: "not-this-machine-00000000000000" });
    const key = signLicense(payload, privateKeyPem);
    expect(() => activateLicense(dir, key)).toThrowError(/different machine/i);
  });

  it("reports LICENSE_PRE_ACTIVATION_EXPIRED for a stale unbound key", () => {
    const dir = freshStorageDir();
    const payload = makePayload({ issuedAt: new Date(Date.now() - 20 * 86400_000).toISOString() });
    const key = signLicense(payload, privateKeyPem);
    try {
      activateLicense(dir, key);
      expect.fail("expected activateLicense to throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/limited time/i);
    }
  });

  it("accepts activation of a key already bound to this machine's fingerprint", () => {
    const dir = freshStorageDir();
    const payload = makePayload({ machineFingerprint: getMachineFingerprint() });
    const key = signLicense(payload, privateKeyPem);
    const status = activateLicense(dir, key);
    expect(status.state).toBe("valid");
  });

  it("stays valid when the stored activation fingerprint is a NON-primary but legitimate identity of this machine (anti-flap)", () => {
    // Reproduces the real bug: a license activated while a virtual adapter
    // (VirtualBox/WSL) was the 'first MAC' bound to THAT value. After the fix the
    // primary fingerprint is the stable machine-id/GUID, but the old value is
    // still a valid candidate — so the license must NOT flap to MACHINE_MISMATCH.
    const legacy = [...getFingerprintCandidates()].find((f) => f !== getMachineFingerprint());
    if (!legacy) return; // machine presents only one identity — nothing to assert

    const dir = freshStorageDir();
    const payload = makePayload();
    const key = signLicense(payload, privateKeyPem);
    activateLicense(dir, key);
    // Rewrite activation.json as if it had been bound to the legacy identity.
    writeFileSync(
      join(dir, "license", "activation.json"),
      JSON.stringify({ licenseId: payload.licenseId, fingerprint: legacy, activatedAt: new Date().toISOString() }),
      "utf8",
    );
    expect(checkLicense(dir).state).toBe("valid");
  });
});
