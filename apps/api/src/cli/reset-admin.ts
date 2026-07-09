#!/usr/bin/env node
/**
 * OFFLINE ADMIN PASSWORD RECOVERY — run only with shell access to the server
 * (docker exec into the api container, or directly if running from source).
 * Not reachable over HTTP; this is the "I'm locked out" escape hatch.
 *
 * Usage:
 *   node dist/cli/reset-admin.js --username admin --password "a-new-temporary-password"
 *
 * Resets the given account's password (forcing a change at next login) and
 * writes an AuditLog entry so the reset is visible in the Audit tab.
 */
import { loadEnv } from "@clg/shared";
import { prisma, userRepository, auditLogRepository } from "@clg/database";
import { hashPassword } from "../lib/passwords.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  if (!args.username || !args.password) {
    console.error("Usage: node dist/cli/reset-admin.js --username <username> --password <new-password>");
    process.exit(1);
  }
  if (args.password.length < 10) {
    console.error("ERROR: password must be at least 10 characters.");
    process.exit(1);
  }

  const user = await userRepository.findByUsername(args.username);
  if (!user) {
    console.error(`ERROR: no account named "${args.username}" was found.`);
    const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { username: true } });
    if (admins.length) console.error("Existing ADMIN accounts: " + admins.map((a) => a.username).join(", "));
    process.exit(1);
  }

  await userRepository.resetPassword(user.id, hashPassword(args.password));
  await auditLogRepository.write({
    user_id: user.id,
    username: user.username,
    action: "auth.admin-reset-by-cli",
    detail: "password reset via server CLI (reset-admin) — forced change at next login",
    ip: null,
  });

  console.log(`Password reset for "${user.username}". They must change it at next login.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("reset-admin failed:", err);
  process.exit(1);
});
