import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { repoRoot, verifyLicense, machineFingerprint, logger, type LicenseResult } from "@clg/shared";

/**
 * Startup license gate for the packaged product.
 *
 * The product is LICENSED, not sold. On boot we read `license.dat`, verify its
 * Ed25519 signature with the embedded PUBLIC key (so a customer can never forge
 * one), and check expiry + machine binding. When enforcement is ON (packaged
 * builds set LICENSE_ENFORCE=true) an invalid/expired/wrong-machine license stops
 * the product from starting. In dev (no flag) we only warn, so the team can run
 * the source without a license file.
 *
 * license.dat location, in order: $LICENSE_FILE, ./license.dat (next to the app),
 * then <repoRoot>/license.dat.
 */
function licensePath(): string {
  if (process.env.LICENSE_FILE && existsSync(process.env.LICENSE_FILE)) return process.env.LICENSE_FILE;
  const cwdFile = resolve(process.cwd(), "license.dat");
  if (existsSync(cwdFile)) return cwdFile;
  return resolve(repoRoot(), "license.dat");
}

export function readLicense(): LicenseResult & { machine: string; path: string } {
  const path = licensePath();
  const machine = machineFingerprint();
  let token = "";
  try {
    token = readFileSync(path, "utf8");
  } catch {
    return { valid: false, reason: "No license file found (license.dat). Contact your vendor.", machine, path };
  }
  return { ...verifyLicense(token, machine), machine, path };
}

/** True when this build must refuse to run without a valid license. */
export function enforcementEnabled(): boolean {
  return process.env.LICENSE_ENFORCE === "true";
}

/**
 * Called once at startup. Returns the result; the caller decides whether to abort.
 * Logs a clear, human-readable line either way.
 */
export function checkLicenseOnStartup(): LicenseResult & { machine: string } {
  const res = readLicense();
  if (res.valid && res.payload) {
    logger.info(
      {
        company: res.payload.company,
        plan: res.payload.plan,
        expires: res.payload.expires ?? "perpetual",
        machineBound: res.payload.machine !== "*",
      },
      "license OK",
    );
  } else if (enforcementEnabled()) {
    logger.error({ reason: res.reason, machine: res.machine }, "LICENSE INVALID — product will not start");
  } else {
    logger.warn({ reason: res.reason }, "license not valid (enforcement off — running in dev mode)");
  }
  return res;
}

/** Safe summary for the /license/status route (never leaks the raw token). */
export function licenseStatus() {
  const res = readLicense();
  return {
    valid: res.valid,
    reason: res.reason,
    enforced: enforcementEnabled(),
    machineId: res.machine,
    license: res.payload
      ? {
          company: res.payload.company,
          plan: res.payload.plan,
          issued: res.payload.issued,
          expires: res.payload.expires,
          seats: res.payload.seats,
          features: res.payload.features,
          machineBound: res.payload.machine !== "*",
        }
      : null,
  };
}
