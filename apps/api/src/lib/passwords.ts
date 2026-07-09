import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Node's built-in scrypt (no bcrypt/argon2 dependency). Cost parameters follow
 * OWASP's current scrypt guidance for interactive login (N=2^14, r=8, p=1).
 * Format: "scrypt$<saltB64>$<hashB64>" — self-describing so params can change
 * later without invalidating stored hashes silently.
 */
const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltB64, hashB64] = parts;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(saltB64!, "base64");
    expected = Buffer.from(hashB64!, "base64");
  } catch {
    return false;
  }
  const actual = scryptSync(password, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
