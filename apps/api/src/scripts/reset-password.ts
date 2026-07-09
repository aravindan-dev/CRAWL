import { PrismaClient } from "@prisma/client";
import { scryptSync, randomBytes } from "node:crypto";

const prisma = new PrismaClient();

// Same format as apps/api/src/lib/passwords.ts
const N = 16384, r = 8, p = 1, KEYLEN = 32;
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function main() {
  const newPassword = "admin12345";
  const hash = hashPassword(newPassword);

  await prisma.user.updateMany({
    data: { password_hash: hash, must_change_password: false }
  });

  console.log("✅ Password reset for ALL users to: admin12345");
  const users = await prisma.user.findMany({
    select: { username: true, role: true, display_name: true }
  });
  console.table(users);
  console.log("Login with username: ksuidkh  password: admin12345");
}

main().catch(console.error).finally(() => prisma.$disconnect());
