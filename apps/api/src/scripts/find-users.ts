import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";

const prisma = new PrismaClient();

// Simple bcrypt-compatible hash — we'll use the same approach as the app
// Actually let's just print users first
async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, username: true, role: true, active: true, display_name: true }
  });
  console.log("=== EXISTING USERS ===");
  console.table(users);

  if (users.length > 0) {
    console.log(`\nFirst user username: ${users[0].username}`);
    console.log(`Role: ${users[0].role}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
