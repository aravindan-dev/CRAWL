import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { repoRoot } from "@clg/shared";
import { checkLicense, type LicenseStatus } from "@clg/license";

const RECHECK_INTERVAL_MS = 15 * 60 * 1000;

let cached: { status: LicenseStatus; at: number } | null = null;

export function licenseStorageDir(): string {
  return join(repoRoot(), "storage");
}

/** Cached for RECHECK_INTERVAL_MS; pass force=true right after activation. */
export function getLicenseStatus(force = false): LicenseStatus {
  if (!force && cached && Date.now() - cached.at < RECHECK_INTERVAL_MS) return cached.status;
  const status = checkLicense(licenseStorageDir());
  cached = { status, at: Date.now() };
  return status;
}

export function invalidateLicenseCache(): void {
  cached = null;
}

// Reachable even with an invalid/missing license, so the lock screen and
// activation flow always work. /auth/* stays reachable too (the auth gate
// still applies its own rules on top) — the web app's boot state machine
// always shows the license lock screen first regardless, but the API itself
// doesn't hard-block login/setup/me just because the license needs attention.
// /license/activate is additionally restricted to ADMIN once any user account
// exists (see plugins/auth.ts).
const ALLOWED_PATHS = new Set([
  "/health",
  "/license/status",
  "/license/activate",
  "/license/fingerprint",
  "/auth/login",
  "/auth/setup",
  "/auth/me",
]);

/**
 * Registers the license gate directly on the root app instance (not via
 * app.register) so the onRequest hook applies globally to every route
 * registered afterward in the same file, without pulling in fastify-plugin.
 */
export function registerLicenseGate(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (path && ALLOWED_PATHS.has(path)) return;

    const status = getLicenseStatus();
    if (status.state === "invalid") {
      return reply.code(403).send({
        error: {
          code: status.code,
          message: status.message,
          vendorContact: process.env.VENDOR_CONTACT ?? "your vendor",
        },
      });
    }
    if (status.state === "grace") {
      reply.header("x-license-warning", `expires-in-${status.graceDaysLeft}-days`);
    }
  });
}
