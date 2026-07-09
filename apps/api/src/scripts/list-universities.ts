import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const universities = await prisma.university.findMany({
    select: { id: true, name: true, country: true, base_url: true, crawl_status: true }
  });

  console.log("=== Universities in Database ===");
  console.table(universities);
}

main().catch(console.error).finally(() => prisma.$disconnect());
