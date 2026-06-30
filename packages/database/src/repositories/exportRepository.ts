import type { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

export const exportRepository = {
  create(input: {
    export_type: Prisma.ExportUncheckedCreateInput["export_type"];
    file_path: string;
    total_records: number;
    scope: string;
  }) {
    return prisma.export.create({ data: input });
  },

  findById(id: string) {
    return prisma.export.findUnique({ where: { id } });
  },

  async list(params: { cursor?: string; take?: number } = {}) {
    const take = Math.min(params.take ?? 25, 100);
    const items = await prisma.export.findMany({
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: { created_at: "desc" },
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
  },
};
