#!/usr/bin/env node
/**
 * SELLER TOOL — issue a license for one company. Run on YOUR machine only; it uses
 * the SECRET private-key.pem (never ship that file). Output: a license.dat token to
 * hand to the customer (they place it next to the app).
 *
 * Usage:
 *   node tools/licensing/issue-license.mjs --company "Acme Corp" \
 *        --machine <customer-machine-id|*> --expires 2027-06-30 \
 *        --plan enterprise --seats 1 --features scholarship,monitor
 *
 *   --machine "*"   → activates on any machine (less secure; convenient)
 *   --expires none  → perpetual license (no expiry)
 *
 * Get the customer's machine id by having them run:
 *   node tools/licensing/machine-id.mjs   (or the bundled "Machine ID.exe")
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, sign as edSign } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? "true" : arr[i + 1]]);
    return acc;
  }, []),
);

const company = args.company;
if (!company) { console.error("ERROR: --company \"Name\" is required."); process.exit(1); }
const machine = args.machine || "*";
const expires = !args.expires || args.expires === "none" ? null : new Date(args.expires).toISOString();
const plan = args.plan || "standard";
const seats = Number(args.seats || 1);
const features = (args.features || "").split(",").map((s) => s.trim()).filter(Boolean);

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const payload = { company, issued: new Date().toISOString(), expires, machine, plan, features, seats };
const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));

let priv;
try { priv = createPrivateKey(readFileSync(resolve(HERE, "private-key.pem"), "utf8")); }
catch { console.error("ERROR: tools/licensing/private-key.pem not found. Run keygen first (see README)."); process.exit(1); }

const sig = b64url(edSign(null, Buffer.from(`CLG1.${payloadB64}`, "utf8"), priv));
const token = `CLG1.${payloadB64}.${sig}`;

const outDir = resolve(HERE, "out");
mkdirSync(outDir, { recursive: true });
const safe = company.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
const outFile = resolve(outDir, `${safe}-license.dat`);
writeFileSync(outFile, token, "utf8");

console.log("License issued:");
console.log("  company :", company);
console.log("  machine :", machine);
console.log("  expires :", expires ?? "perpetual");
console.log("  plan    :", plan, "| seats:", seats, "| features:", features.join(",") || "(base)");
console.log("\nGive the customer this file (rename to license.dat next to the app):");
console.log("  " + outFile);
