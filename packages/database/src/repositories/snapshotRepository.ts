import type { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

export const snapshotRepository = {
  create(data: Prisma.PageSnapshotUncheckedCreateInput) {
    return prisma.pageSnapshot.create({ data });
  },

  findByLink(discovered_link_id: string) {
    return prisma.pageSnapshot.findFirst({
      where: { discovered_link_id },
      orderBy: { created_at: "desc" },
    });
  },

  findById(id: string) {
    return prisma.pageSnapshot.findUnique({ where: { id } });
  },
};
