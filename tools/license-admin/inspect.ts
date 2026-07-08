#!/usr/bin/env tsx
/**
 * VENDOR ONLY — decode and verify any issued .key file, and pretty-print it.
 * Useful for confirming what you're about to send, or diagnosing a customer's
 * pasted key without touching the running product.
 *
 * Usage: pnpm --filter license-admin inspect issued/acme-corp-<id>.key
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyLicense, LicenseError } from "@clg/license";

const file = process.argv[2];
if (!file) {
  console.error("ERROR: pass a path to a .key file to inspect.");
  process.exit(1);
}

const raw = readFileSync(resolve(process.cwd(), file), "utf8");

try {
  const payload = verifyLicense(raw);
  console.log("Signature: VALID\n");
  console.log(JSON.stringify(payload, null, 2));
  const daysLeft = Math.ceil((Date.parse(payload.expiresAt) - Date.now()) / 86_400_000);
  console.log(`\nDays until expiry: ${daysLeft}`);
  console.log(`Activation state: ${payload.machineFingerprint ? "fingerprint-bound" : "pre-activation (unbound)"}`);
} catch (err) {
  if (err instanceof LicenseError) {
    console.error(`Signature/format check FAILED: [${err.code}] ${err.message}`);
  } else {
    console.error("Signature/format check FAILED:", err);
  }
  process.exit(1);
}
