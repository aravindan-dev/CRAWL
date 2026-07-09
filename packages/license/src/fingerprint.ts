import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, networkInterfaces, cpus, platform, arch, totalmem } from "node:os";

/** SHA-256 → first 32 hex chars: the fingerprint shape used everywhere. */
function sha32(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/**
 * The Linux kernel/systemd machine ID — generated once at OS install, persists
 * across reboots and (crucially) across container recreation, UNLIKE a Docker
 * container's own hostname/MAC (which Docker reassigns per container instance).
 * Read from the HOST via a read-only bind mount (`/etc/machine-id:/etc/machine-id:ro`
 * in docker-compose.yml) — the container sees the real host's identity, not its own
 * ephemeral one. Absent on Windows, where the MachineGuid scheme below applies.
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

/**
 * The Windows machine GUID (`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`) —
 * the canonical, network-INDEPENDENT machine identity, generated once at OS
 * install and stable across reboots, network changes, dock/undock, and VM/VPN
 * software coming and going. The Windows analogue of Linux's /etc/machine-id.
 *
 * This replaces the old "first non-internal MAC" scheme, which was unstable: on a
 * typical Windows dev/host machine the "first" enumerated adapter is often a
 * VIRTUAL one (VirtualBox `0a:00:27…`, Hyper-V/WSL `vEthernet 00:15:5d…`, Docker
 * `02:42…`) whose presence and enumeration order change whenever that software
 * starts/stops/updates — flipping the fingerprint and locking out a valid license
 * with LICENSE_MACHINE_MISMATCH. Cached per process (a spawned `reg` query is
 * cheap but not free, and the value never changes while the process runs).
 */
let winGuidCache: string | null | undefined;
function windowsMachineGuid(): string | null {
  if (winGuidCache !== undefined) return winGuidCache;
  winGuidCache = null;
  if (platform() !== "win32") return winGuidCache;
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
    if (m) winGuidCache = m[1]!.toLowerCase();
  } catch {
    /* reg unavailable / blocked — fall back to the MAC scheme in the callers */
  }
  return winGuidCache;
}

// Virtual / non-physical network adapters, identified by adapter NAME or by a
// known virtualization OUI (first 3 MAC octets). Excluded when choosing a
// *fallback* physical MAC so that fallback is stable; still accepted as legacy
// candidates (an old activation may have bound to one of them — see below).
const VIRTUAL_NAME_RE =
  /(vethernet|hyper-?v|wsl|virtualbox|vbox|vmware|docker|loopback|bluetooth|tap[-_ ]?windows|tunnel|zerotier|tailscale|npcap|pseudo|\bvpn\b|teredo|isatap|nord|wireguard|openvpn)/i;
const VIRTUAL_OUI = new Set([
  "0a:00:27", // VirtualBox host-only
  "08:00:27", // VirtualBox NAT
  "00:15:5d", // Hyper-V / WSL vEthernet
  "00:05:69", "00:0c:29", "00:1c:14", "00:50:56", // VMware
  "00:03:ff", // Microsoft virtual
  "02:42:00", // Docker bridge (locally administered)
]);

interface Nic { name: string; mac: string }

/** Every non-internal interface with a real MAC, de-duplicated (a NIC appears
 *  once per address family in os.networkInterfaces()). */
function nonInternalNics(): Nic[] {
  const ifaces = networkInterfaces();
  const seen = new Set<string>();
  const out: Nic[] = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.internal || !ni.mac || ni.mac === "00:00:00:00:00:00") continue;
      const mac = ni.mac.toLowerCase();
      const key = `${name}|${mac}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, mac });
    }
  }
  return out;
}

function isVirtual(n: Nic): boolean {
  return VIRTUAL_NAME_RE.test(n.name) || VIRTUAL_OUI.has(n.mac.slice(0, 8));
}

/** Physical-adapter MACs, virtual adapters removed, sorted for determinism (so
 *  enumeration order and which adapter is currently "up" no longer matter). */
function physicalMacsSorted(): string[] {
  return Array.from(new Set(nonInternalNics().filter((n) => !isVirtual(n)).map((n) => n.mac))).sort();
}

/** Legacy fallback only: the first non-internal MAC in enumeration order (the
 *  old, unstable scheme — kept solely so its value stays a valid candidate). */
function firstMac(): string {
  return nonInternalNics()[0]?.mac ?? "";
}

/** Round to nearest 8 GB so a RAM upgrade alone doesn't invalidate the license. */
function ramBucketGb(): number {
  return Math.round(totalmem() / (8 * 1024 ** 3)) * 8;
}

/** The stable, network-independent part of every fingerprint variant. */
function suffix(): string {
  return `${cpus()[0]?.model ?? ""}|${platform()}|${arch()}|${ramBucketGb()}gb`;
}

/**
 * A stable fingerprint for THIS machine, used to bind a license to one install so
 * a copied deployment won't activate elsewhere. Deterministic across restarts AND
 * across virtual-adapter churn (the old scheme's failure mode).
 *
 * Priority: host machine-id (Linux/Docker) → Windows MachineGuid → sorted
 * physical MAC → first MAC (last-ditch). This is the value shown on the license/
 * activation screen and written into a new activation.
 *
 * IMPORTANT: switching a deployment between host-run and Docker-run (or between
 * OSes) changes this — pick one deployment mode before activating.
 */
export function getMachineFingerprint(): string {
  const hostId = hostMachineId();
  if (hostId) return sha32(`machine-id:${hostId}|${suffix()}`);
  const guid = windowsMachineGuid();
  if (guid) return sha32(`machine-guid:${guid}|${suffix()}`);
  const mac = physicalMacsSorted()[0] ?? firstMac();
  return sha32(`${hostname()}|${mac}|${suffix()}`);
}

/**
 * ALL identities THIS machine can legitimately present: the stable primary above
 * PLUS every value the old first-MAC scheme could have produced (any non-internal
 * MAC, in any enumeration order — including virtual adapters). A license bound to
 * ANY of these still validates, so the fingerprint no longer flaps when a virtual
 * adapter (VirtualBox / WSL / Docker) appears, changes MAC, or reorders — the
 * cause of spurious "activated on a different machine" lock-outs.
 *
 * Every candidate is derived from this machine's OWN hardware, so a DIFFERENT
 * machine (different machine-id/GUID and different MACs) can never match — the
 * security property is preserved; the set is only ever more permissive toward the
 * SAME physical machine.
 */
export function getFingerprintCandidates(): Set<string> {
  const s = suffix();
  const c = new Set<string>();
  c.add(getMachineFingerprint());
  const hostId = hostMachineId();
  if (hostId) c.add(sha32(`machine-id:${hostId}|${s}`));
  const guid = windowsMachineGuid();
  if (guid) c.add(sha32(`machine-guid:${guid}|${s}`));
  const phys = physicalMacsSorted()[0];
  if (phys) c.add(sha32(`${hostname()}|${phys}|${s}`));
  // Legacy: the old scheme hashed hostname + WHICHEVER non-internal MAC happened
  // to enumerate first. Enumerate ALL of them (physical AND virtual) so any prior
  // activation keeps matching regardless of today's adapter order/state.
  for (const n of nonInternalNics()) c.add(sha32(`${hostname()}|${n.mac}|${s}`));
  return c;
}
