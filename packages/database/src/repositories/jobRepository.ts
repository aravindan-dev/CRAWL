import type { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

export const jobRepository = {
  create(input: {
    university_id?: string | null;
    job_type: Prisma.CrawlJobUncheckedCreateInput["job_type"];
    crawl_context?: Prisma.CrawlJobUncheckedCreateInput["crawl_context"];
    stats?: Prisma.InputJsonValue;
  }) {
    return prisma.crawlJob.create({
      data: {
        university_id: input.university_id ?? null,
        job_type: input.job_type,
        crawl_context: input.crawl_context ?? "ELIGIBILITY",
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

  /** Contexts (ELIGIBILITY/SCHOLARSHIP) that already have a COMPLETED crawl for
   *  this university — used to resume a chained "both" crawl at the right
   *  context instead of restarting eligibility after scholarship was already
   *  reached (or already done). */
  async completedContexts(university_id: string): Promise<Set<string>> {
    const rows = await prisma.crawlJob.findMany({
      where: { university_id, status: "COMPLETED" },
      select: { crawl_context: true },
      distinct: ["crawl_context"],
    });
    return new Set(rows.map((r) => r.crawl_context));
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
