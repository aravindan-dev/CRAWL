#!/usr/bin/env tsx
/**
 * VENDOR ONLY — issue a license for one company. Uses the SECRET keys/private.pem
 * (never ship that file). Writes issued/<customer>-<licenseId>.key to hand to the
 * customer, and appends a row to issued/registry.csv (the sales ledger).
 *
 * Usage:
 *   pnpm --filter license-admin issue --customer "Aliff" --email x@y.com --months 12 \
 *     [--fingerprint <hex>] [--max-universities 500] [--max-users 25]
 *
 *   Without --fingerprint: issues a PRE-ACTIVATION license (activates on whichever
 *   machine pastes it first, within 14 days of issue). Use this for the fast sales
 *   flow, then ask the customer for the fingerprint it shows post-activation and
 *   issue a fingerprint-bound FINAL key with --fingerprint to replace it.
 *
 *   With --fingerprint: a fully-bound license (final key / renewal / transfer).
 *   Get the customer's fingerprint from their License page (or docs/LICENSING.md
 *   fingerprint-first flow).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { signLicense, type LicensePayload } from "@clg/license";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const customerName = args.customer;
const customerEmail = args.email;
if (!customerName || !customerEmail) {
  console.error('ERROR: --customer "Name" and --email x@y.com are required.');
  process.exit(1);
}

const months = Number(args.months ?? "12");
if (!Number.isFinite(months) || months <= 0) {
  console.error("ERROR: --months must be a positive number.");
  process.exit(1);
}

const issuedAt = new Date();
const expiresAt = new Date(issuedAt);
expiresAt.setMonth(expiresAt.getMonth() + months);

const maxUniversities = args["max-universities"] ? Number(args["max-universities"]) : null;
const maxUsers = args["max-users"] ? Number(args["max-users"]) : null;
const machineFingerprint = args.fingerprint ?? null;

const payload: LicensePayload = {
  schema: 1,
  productId: "clg-search",
  edition: "server",
  licenseId: randomUUID(),
  customerName,
  customerEmail,
  issuedAt: issuedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
  maxUniversities,
  maxUsers,
  machineFingerprint,
};

let privateKeyPem: string;
try {
  privateKeyPem = readFileSync(resolve(HERE, "keys", "private.pem"), "utf8");
} catch {
  console.error("ERROR: tools/license-admin/keys/private.pem not found. Run keygen first: pnpm --filter license-admin keygen");
  process.exit(1);
}

const key = signLicense(payload, privateKeyPem);

const issuedDir = resolve(HERE, "issued");
mkdirSync(issuedDir, { recursive: true });
const safe = customerName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
const outFile = resolve(issuedDir, `${safe}-${payload.licenseId}.key`);
writeFileSync(outFile, key, "utf8");

const registryPath = resolve(issuedDir, "registry.csv");
if (!existsSync(registryPath)) {
  writeFileSync(
    registryPath,
    "licenseId,customerName,customerEmail,issuedAt,expiresAt,machineFingerprint,maxUniversities,maxUsers\n",
    "utf8",
  );
}
appendFileSync(
  registryPath,
  [
    payload.licenseId,
    JSON.stringify(customerName),
    customerEmail,
    payload.issuedAt,
    payload.expiresAt,
    machineFingerprint ?? "(pre-activation)",
    maxUniversities ?? "unlimited",
    maxUsers ?? "unlimited",
  ].join(",") + "\n",
  "utf8",
);

console.log("License issued:");
console.log("  customer   :", customerName, `<${customerEmail}>`);
console.log("  licenseId  :", payload.licenseId);
console.log("  expires    :", payload.expiresAt.slice(0, 10), `(${months} months)`);
console.log("  fingerprint:", machineFingerprint ?? "(none — pre-activation key, valid 14 days to redeem)");
console.log("  caps       :", `maxUniversities=${maxUniversities ?? "unlimited"} maxUsers=${maxUsers ?? "unlimited"}`);
console.log("\nSend the customer this file (they paste its contents on the Activation page):");
console.log("  " + outFile);
