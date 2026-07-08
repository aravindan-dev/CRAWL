import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, networkInterfaces, cpus, platform, arch, totalmem } from "node:os";

/**
 * The Linux kernel/systemd machine ID — generated once at OS install, persists
 * across reboots and (crucially) across container recreation, UNLIKE a Docker
 * container's own hostname/MAC (which Docker reassigns per container instance).
 * Read from the HOST via a read-only bind mount (`/etc/machine-id:/etc/machine-id:ro`
 * in docker-compose.yml) — the container sees the real host's identity, not its own
 * ephemeral one. Absent on Windows, where the hostname+MAC scheme below applies.
 */
function hostMachineId(): string | null {
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

function firstMac(): string {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (!ni.internal && ni.mac && ni.mac !== "00:00:00:00:00:00") return ni.mac.toLowerCase();
    }
  }
  return "";
}

/** Round to nearest 8 GB so a RAM upgrade alone doesn't invalidate the license. */
function ramBucketGb(): number {
  return Math.round(totalmem() / (8 * 1024 ** 3)) * 8;
}

/**
 * A stable fingerprint for THIS machine, used to bind a license to one install so a
 * copied deployment won't activate elsewhere. Deterministic across restarts.
 *
 * On Linux (server/Docker deployments): host `/etc/machine-id` + CPU model + arch +
 * RAM bucket — stable across container restarts/recreation/updates, which a
 * hostname+MAC scheme is NOT (Docker reassigns both per container instance).
 *
 * Elsewhere (Windows/host-run deployments): hostname + first non-internal MAC + CPU
 * model + arch + RAM bucket.
 *
 * IMPORTANT: the fingerprint shown on the license/activation screen is the one that
 * counts. Switching a deployment between host-run and Docker-run counts as a machine
 * change — pick one deployment mode before activating.
 */
export function getMachineFingerprint(): string {
  const cpu = cpus()[0]?.model ?? "";
  const ram = ramBucketGb();
  const hostId = hostMachineId();
  const raw = hostId
    ? `machine-id:${hostId}|${cpu}|${platform()}|${arch()}|${ram}gb`
    : `${hostname()}|${firstMac()}|${cpu}|${platform()}|${arch()}|${ram}gb`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}
