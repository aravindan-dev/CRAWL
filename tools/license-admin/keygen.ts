#!/usr/bin/env tsx
/**
 * VENDOR ONLY — one-time: generate the Ed25519 keypair that signs every license.
 * The PRIVATE key never leaves keys/private.pem (gitignored). Paste the printed
 * PUBLIC key into packages/license/src/publicKey.ts so the product can verify
 * licenses without ever being able to forge one.
 *
 * Run: pnpm --filter license-admin keygen [--force]
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = resolve(HERE, "keys");
const PRIVATE_PATH = resolve(KEYS_DIR, "private.pem");
const PUBLIC_PATH = resolve(KEYS_DIR, "public.pem");

const force = process.argv.includes("--force");
if (existsSync(PRIVATE_PATH) && !force) {
  console.error(
    `ERROR: ${PRIVATE_PATH} already exists. Regenerating it invalidates every license\n` +
      "already issued with the old key. Pass --force only if you intend that.",
  );
  process.exit(1);
}

mkdirSync(KEYS_DIR, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

writeFileSync(PRIVATE_PATH, privatePem, "utf8");
try {
  chmodSync(PRIVATE_PATH, 0o600);
} catch {
  /* chmod is a no-op on Windows filesystems — fine, the file stays gitignored */
}
writeFileSync(PUBLIC_PATH, publicPem, "utf8");

console.log("Keypair generated.");
console.log(`  private key -> ${PRIVATE_PATH}  (SECRET — never commit, never ship)`);
console.log(`  public key  -> ${PUBLIC_PATH}`);
console.log("\nPaste this into packages/license/src/publicKey.ts:\n");
console.log(publicPem);
