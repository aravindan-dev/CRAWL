import type { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

export interface CrawlLogInput {
  university_id?: string | null;
  discovered_link_id?: string | null;
  action: Prisma.CrawlLogUncheckedCreateInput["action"];
  status: Prisma.CrawlLogUncheckedCreateInput["status"];
  message?: string | null;
  duration_ms?: number | null;
  error_stack?: string | null;
}

export interface ListLogsParams {
  cursor?: string;
  take?: number;
  university_id?: string;
  action?: string;
  status?: string;
}

export const logRepository = {
  write(input: CrawlLogInput) {
    return prisma.crawlLog.create({
      data: {
        university_id: input.university_id ?? null,
        discovered_link_id: input.discovered_link_id ?? null,
        action: input.action,
        status: input.status,
        message: input.message ?? null,
        duration_ms: input.duration_ms ?? null,
        error_stack: input.error_stack ?? null,
      },
    });
  },

  async list(params: ListLogsParams = {}) {
    const take = Math.min(params.take ?? 50, 200);
    const where: Prisma.CrawlLogWhereInput = {};
    if (params.university_id) where.university_id = params.university_id;
    if (params.action) where.action = params.action as Prisma.CrawlLogWhereInput["action"];
    if (params.status) where.status = params.status as Prisma.CrawlLogWhereInput["status"];

    const items = await prisma.crawlLog.findMany({
      where,
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: { created_at: "desc" },
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
  },
};
