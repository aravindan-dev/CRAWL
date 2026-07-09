import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const stats = await p.discoveredLink.groupBy({
  by: ['page_class', 'status'],
  where: {
    university: { name: { contains: 'Canberra', mode: 'insensitive' } },
    content_verified: true
  },
  _count: { id: true },
  orderBy: { _count: { id: 'desc' } },
  take: 15
});
console.log("=== Validated Links by page_class+status ===");
console.table(stats.map(s => ({ page_class: s.page_class, status: s.status, count: s._count.id })));

// Also show un-verified by class to see what's being missed
const unverified = await p.discoveredLink.groupBy({
  by: ['page_class'],
  where: {
    university: { name: { contains: 'Canberra', mode: 'insensitive' } },
    content_verified: false,
    status: { notIn: ['REJECTED_CROSS_CONTEXT', 'BLOCKED', 'PENDING'] }
  },
  _count: { id: true },
  orderBy: { _count: { id: 'desc' } },
  take: 10
});
console.log("\n=== Unverified (crawled but not content_verified) ===");
console.table(unverified.map(s => ({ page_class: s.page_class, count: s._count.id })));

await p.$disconnect();
