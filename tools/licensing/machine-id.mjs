#!/usr/bin/env node
/**
 * CUSTOMER TOOL — prints this computer's Machine ID. The customer runs it once and
 * emails the ID to the vendor, who issues a license bound to that machine.
 *
 * This MUST produce the identical fingerprint to packages/shared/src/license.ts
 * (machineFingerprint) — kept as a manual copy (not an import) so this file stays
 * dependency-free and runs anywhere with plain Node, including inside a customer's
 * Docker container with no workspace/pnpm resolution available. If you change the
 * fingerprint logic in license.ts, mirror the change here too.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, networkInterfaces, cpus, platform, arch } from "node:os";

// Linux server / Docker deployments: prefer the HOST's stable machine-id (mount
// it read-only into the container as /etc/machine-id) — a container's own
// hostname/MAC are reassigned by Docker on every recreation, so binding to
// those would silently invalidate the license on a routine restart/update.
function hostMachineId() {
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = readFileSync(p, "utf8").trim();
      if (id) return id;
    } catch {
      /* not present / not mounted — try the next path, then fall back */
    }
  }
  return null;
}

function machineFingerprint() {
  const hostId = hostMachineId();
  const cpu = cpus()[0]?.model ?? "";
  if (hostId) {
    const raw = `machine-id:${hostId}|${cpu}|${platform()}|${arch()}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 24);
  }
  let mac = "";
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (!ni.internal && ni.mac && ni.mac !== "00:00:00:00:00:00") { mac = ni.mac; break; }
    }
    if (mac) break;
  }
  const raw = `${hostname()}|${mac}|${cpu}|${platform()}|${arch()}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

const id = machineFingerprint();

console.log("");
console.log("  CLG Search — Machine ID");
console.log("  ───────────────────────────────────────────");
console.log("  " + id);
console.log("  ───────────────────────────────────────────");
console.log("  Send this ID to your vendor to receive a license.");
console.log("");
