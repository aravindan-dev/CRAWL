import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { repoRoot } from "@clg/shared";

const ENV_PATH = resolve(repoRoot(), ".env");
let cached: string | null = null;

/**
 * Session cookies are HMAC-signed with this secret. Generated once on first
 * boot and persisted to .env (same pattern as settingsService) so every
 * restart uses the same secret and existing sessions keep validating.
 */
export function getSessionSecret(): string {
  if (cached) return cached;
  if (process.env.SESSION_SECRET) {
    cached = process.env.SESSION_SECRET;
    return cached;
  }

  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  const existing = lines.find((l) => /^SESSION_SECRET=/.test(l));
  const existingValue = existing?.split("=").slice(1).join("=").trim();
  if (existingValue) {
    cached = existingValue;
    process.env.SESSION_SECRET = existingValue;
    return cached;
  }

  const secret = randomBytes(32).toString("hex");
  lines.push(`SESSION_SECRET=${secret}`);
  writeFileSync(ENV_PATH, lines.join("\n"), "utf8");
  cached = secret;
  process.env.SESSION_SECRET = secret;
  return cached;
}
