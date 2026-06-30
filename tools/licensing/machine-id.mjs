#!/usr/bin/env node
/**
 * CUSTOMER TOOL — prints this computer's Machine ID. The customer runs it once and
 * emails the ID to the vendor, who issues a license bound to that machine.
 *
 * This MUST produce the identical fingerprint to packages/shared/src/license.ts
 * (machineFingerprint). Kept dependency-free so it runs anywhere with plain Node.
 */
import { createHash } from "node:crypto";
import { hostname, networkInterfaces, cpus, platform, arch } from "node:os";

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
const id = createHash("sha256").update(raw).digest("hex").slice(0, 24);

console.log("");
console.log("  CLG Search — Machine ID");
console.log("  ───────────────────────────────────────────");
console.log("  " + id);
console.log("  ───────────────────────────────────────────");
console.log("  Send this ID to your vendor to receive a license.");
console.log("");
