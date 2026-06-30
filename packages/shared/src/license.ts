import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { hostname, networkInterfaces, cpus, platform, arch } from "node:os";

/**
 * COMMERCIAL LICENSING (offline, signature-verified, machine-bindable).
 *
 * The product is LICENSED, not sold (see LICENSE.txt). A license is a signed token
 * the seller issues per company. The product VERIFIES it with an embedded Ed25519
 * PUBLIC key — it can never FORGE a license because the PRIVATE signing key stays
 * with the seller. So the same product binary can be licensed to many companies,
 * each with their own machine-bound key, and a copied install won't activate
 * elsewhere.
 *
 *   token = "CLG1.<payloadB64url>.<signatureB64url>"
 *   payload = { company, issued, expires, machine, plan, features, seats }
 *   signature = Ed25519( "CLG1.<payloadB64url>" )  // header+payload, anti-tamper
 *
 * Verification is asymmetric, so shipping this PUBLIC key is safe.
 */
const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyvPMG1IsCy/zCXlk2Ebt27dpY7jW3R5w85CBrjyAXXE=
-----END PUBLIC KEY-----`;

export interface LicensePayload {
  company: string;
  issued: string; // ISO date
  expires: string | null; // ISO date, or null = perpetual
  machine: string; // machine fingerprint this license is bound to, or "*" = any machine
  plan: string; // e.g. "standard", "enterprise"
  features: string[]; // enabled feature flags
  seats: number; // informational: licensed install count
}
export interface LicenseResult {
  valid: boolean;
  reason: string; // human-readable
  payload?: LicensePayload;
}

const b64url = {
  enc: (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
};

/**
 * A stable fingerprint for THIS machine (hostname + first non-internal MAC + CPU
 * model + platform/arch), hashed. Used to bind a license to one computer so a copy
 * won't run elsewhere. Short, opaque, and deterministic on the same machine.
 */
export function machineFingerprint(): string {
  let mac = "";
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (!ni.internal && ni.mac && ni.mac !== "00:00:00:00:00:00") { mac = ni.mac; break; }
    }
    if (mac) break;
  }
  const cpu = cpus()[0]?.model ?? "";
  const raw = `${hostname()}|${mac}|${cpu}|${platform()}|${arch()}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

/** Verify a license token's signature, expiry, and (optional) machine binding. */
export function verifyLicense(token: string, machineId: string = machineFingerprint()): LicenseResult {
  if (!token || typeof token !== "string") return { valid: false, reason: "No license provided." };
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "CLG1") return { valid: false, reason: "License format is not recognized." };
  const [, payloadB64, sigB64] = parts;

  // 1) Signature — proves the seller issued it and it wasn't altered.
  let okSig = false;
  try {
    const key = createPublicKey(LICENSE_PUBLIC_KEY_PEM);
    okSig = edVerify(null, Buffer.from(`CLG1.${payloadB64}`, "utf8"), key, b64url.dec(sigB64!));
  } catch {
    okSig = false;
  }
  if (!okSig) return { valid: false, reason: "License signature is invalid (tampered or not issued by the vendor)." };

  // 2) Decode payload.
  let payload: LicensePayload;
  try {
    payload = JSON.parse(b64url.dec(payloadB64!).toString("utf8")) as LicensePayload;
  } catch {
    return { valid: false, reason: "License payload is corrupt." };
  }

  // 3) Expiry.
  if (payload.expires) {
    const exp = Date.parse(payload.expires);
    if (Number.isFinite(exp) && Date.now() > exp) {
      return { valid: false, reason: `License expired on ${payload.expires.slice(0, 10)}. Contact the vendor to renew.`, payload };
    }
  }

  // 4) Machine binding.
  if (payload.machine && payload.machine !== "*" && payload.machine !== machineId) {
    return { valid: false, reason: "This license is registered to a different computer. Each license activates on one machine.", payload };
  }

  return { valid: true, reason: "Licensed.", payload };
}
