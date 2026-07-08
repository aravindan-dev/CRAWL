import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LicenseError, LICENSE_ERROR_MESSAGES } from "./errors.js";
import { verifyLicense as verifySignature } from "./crypto.js";
import { getMachineFingerprint } from "./fingerprint.js";
import type { LicensePayload, LicenseStatus } from "./types.js";

export const GRACE_PERIOD_DAYS = 7;
export const PRE_ACTIVATION_VALID_DAYS = 14;
const CLOCK_ROLLBACK_TOLERANCE_MS = 48 * 60 * 60 * 1000;
const LAST_SEEN_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

interface Activation {
  licenseId: string;
  fingerprint: string;
  activatedAt: string;
}

function licenseKeyPath(storageDir: string): string {
  return join(storageDir, "license", "license.key");
}
function activationPath(storageDir: string): string {
  return join(storageDir, "license", "activation.json");
}
function lastSeenPath(storageDir: string): string {
  return join(storageDir, "license", ".last-seen");
}

function readActivation(storageDir: string): Activation | null {
  try {
    return JSON.parse(readFileSync(activationPath(storageDir), "utf8")) as Activation;
  } catch {
    return null;
  }
}

function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * Guards against a rolled-back system clock being used to bypass expiry. Persists
 * the last-observed time and, if the current time is earlier than that by more than
 * the tolerance, reports tampering. Updates the marker at most once an hour.
 */
function checkClockAndRecord(storageDir: string): boolean {
  const p = lastSeenPath(storageDir);
  const now = Date.now();
  let tampered = false;
  try {
    const lastSeen = Date.parse(readFileSync(p, "utf8").trim());
    if (Number.isFinite(lastSeen) && now < lastSeen - CLOCK_ROLLBACK_TOLERANCE_MS) tampered = true;
    if (tampered || now - lastSeen < LAST_SEEN_UPDATE_INTERVAL_MS) return tampered;
  } catch {
    /* no marker yet — first run */
  }
  try {
    mkdirSync(join(storageDir, "license"), { recursive: true });
    writeFileSync(p, new Date(now).toISOString(), "utf8");
  } catch {
    /* non-fatal — the marker is a best-effort guard */
  }
  return tampered;
}

function invalid(code: Parameters<typeof errMsg>[0]): LicenseStatus {
  return { state: "invalid", code, message: errMsg(code) };
}
function errMsg(code: keyof typeof LICENSE_ERROR_MESSAGES): string {
  return LICENSE_ERROR_MESSAGES[code];
}

/** Reads and evaluates the license for this installation. Never throws. */
export function checkLicense(storageDir: string): LicenseStatus {
  if (checkClockAndRecord(storageDir)) return invalid("LICENSE_CLOCK_TAMPER");

  let raw: string;
  try {
    raw = readFileSync(licenseKeyPath(storageDir), "utf8");
  } catch {
    return invalid("LICENSE_MISSING");
  }

  let payload: LicensePayload;
  try {
    payload = verifySignature(raw);
  } catch (err) {
    if (err instanceof LicenseError) return { state: "invalid", code: err.code, message: err.message };
    return invalid("LICENSE_MALFORMED");
  }

  const now = new Date();
  const activation = readActivation(storageDir);

  if (!activation || activation.licenseId !== payload.licenseId) {
    // Not yet bound to this machine. A pre-activation key is only valid to redeem
    // for a limited window after issue, so unbound keys can't circulate forever.
    if (payload.machineFingerprint === null) {
      const issuedAt = new Date(payload.issuedAt);
      if (daysBetween(now, issuedAt) > PRE_ACTIVATION_VALID_DAYS) {
        return invalid("LICENSE_PRE_ACTIVATION_EXPIRED");
      }
    }
    return invalid("LICENSE_NOT_ACTIVATED");
  }

  const liveFingerprint = getMachineFingerprint();
  if (activation.fingerprint !== liveFingerprint) return invalid("LICENSE_MACHINE_MISMATCH");
  if (payload.machineFingerprint !== null && payload.machineFingerprint !== liveFingerprint) {
    return invalid("LICENSE_MACHINE_MISMATCH");
  }

  const expiresAt = new Date(payload.expiresAt);
  const daysLeft = Math.ceil(daysBetween(expiresAt, now));
  if (daysLeft >= 0) return { state: "valid", payload, daysLeft };

  const graceDaysLeft = GRACE_PERIOD_DAYS + daysLeft; // daysLeft is negative here
  if (graceDaysLeft > 0) return { state: "grace", payload, graceDaysLeft };

  return invalid("LICENSE_EXPIRED");
}

/**
 * Binds a license key to this machine: verifies the signature, then atomically
 * writes license.key + activation.json recording the live fingerprint. Used by the
 * API's POST /license/activate route.
 */
export function activateLicense(storageDir: string, licenseKey: string): LicenseStatus {
  const payload = verifySignature(licenseKey); // throws LicenseError on failure — let the caller handle it

  if (payload.machineFingerprint === null) {
    const issuedAt = new Date(payload.issuedAt);
    if (daysBetween(new Date(), issuedAt) > PRE_ACTIVATION_VALID_DAYS) {
      throw new LicenseError("LICENSE_PRE_ACTIVATION_EXPIRED", errMsg("LICENSE_PRE_ACTIVATION_EXPIRED"));
    }
  } else if (payload.machineFingerprint !== getMachineFingerprint()) {
    throw new LicenseError("LICENSE_MACHINE_MISMATCH", errMsg("LICENSE_MACHINE_MISMATCH"));
  }

  const dir = join(storageDir, "license");
  mkdirSync(dir, { recursive: true });

  const activation: Activation = {
    licenseId: payload.licenseId,
    fingerprint: getMachineFingerprint(),
    activatedAt: new Date().toISOString(),
  };

  const keyTmp = `${licenseKeyPath(storageDir)}.tmp`;
  const actTmp = `${activationPath(storageDir)}.tmp`;
  writeFileSync(keyTmp, licenseKey, "utf8");
  writeFileSync(actTmp, JSON.stringify(activation, null, 2), "utf8");
  renameSync(keyTmp, licenseKeyPath(storageDir));
  renameSync(actTmp, activationPath(storageDir));

  return checkLicense(storageDir);
}

export function licenseFileExists(storageDir: string): boolean {
  return existsSync(licenseKeyPath(storageDir));
}
