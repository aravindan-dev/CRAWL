import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { activateLicense, getMachineFingerprint, LicenseError } from "@clg/license";
import { HttpError } from "../lib/http.js";
import { getLicenseStatus, invalidateLicenseCache, licenseStorageDir } from "../plugins/license.js";

/** Safe fields only — never echoes the raw license key. */
function safeStatus() {
  const status = getLicenseStatus();
  if (status.state === "invalid") {
    return { state: status.state, code: status.code, message: status.message };
  }
  const { payload } = status;
  return {
    state: status.state,
    customerName: payload.customerName,
    edition: payload.edition,
    expiresAt: payload.expiresAt,
    maxUsers: payload.maxUsers,
    maxUniversities: payload.maxUniversities,
    licenseId: payload.licenseId,
    fingerprint: getMachineFingerprint(),
    daysLeft: status.state === "valid" ? status.daysLeft : undefined,
    graceDaysLeft: status.state === "grace" ? status.graceDaysLeft : undefined,
  };
}

export async function licenseRoutes(app: FastifyInstance) {
  app.get("/license/status", async () => safeStatus());

  app.get("/license/fingerprint", async () => ({ fingerprint: getMachineFingerprint() }));

  app.post(
    "/license/activate",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const parsed = z.object({ licenseKey: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "A license key is required.", parsed.error.issues);

      try {
        activateLicense(licenseStorageDir(), parsed.data.licenseKey);
      } catch (err) {
        if (err instanceof LicenseError) throw new HttpError(422, err.message, { code: err.code });
        throw err;
      }
      invalidateLicenseCache();
      return safeStatus();
    },
  );
}
