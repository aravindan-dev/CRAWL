import type { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

export const jobRepository = {
  create(input: {
    university_id?: string | null;
    job_type: Prisma.CrawlJobUncheckedCreateInput["job_type"];
    stats?: Prisma.InputJsonValue;
  }) {
    return prisma.crawlJob.create({
      data: {
        university_id: input.university_id ?? null,
        job_type: input.job_type,
        status: "QUEUED",
        stats: input.stats ?? {},
      },
    });
  },

  markRunning(id: string) {
    return prisma.crawlJob.update({
      where: { id },
      data: { status: "RUNNING", started_at: new Date() },
    });
  },

  markCompleted(id: string, stats?: Prisma.InputJsonValue) {
    return prisma.crawlJob.update({
      where: { id },
      data: {
        status: "COMPLETED",
        finished_at: new Date(),
        ...(stats ? { stats } : {}),
      },
    });
  },

  markFailed(id: string, deadLetter = false, stats?: Prisma.InputJsonValue) {
    return prisma.crawlJob.update({
      where: { id },
      data: {
        status: deadLetter ? "DEAD_LETTER" : "FAILED",
        finished_at: new Date(),
        ...(stats ? { stats } : {}),
      },
    });
  },

  findById(id: string) {
    return prisma.crawlJob.findUnique({ where: { id } });
  },

  async list(params: { cursor?: string; take?: number; status?: string; job_type?: string } = {}) {
    const take = Math.min(params.take ?? 25, 100);
    const where: Prisma.CrawlJobWhereInput = {};
    if (params.status) where.status = params.status as Prisma.CrawlJobWhereInput["status"];
    if (params.job_type) where.job_type = params.job_type as Prisma.CrawlJobWhereInput["job_type"];
    const items = await prisma.crawlJob.findMany({
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
