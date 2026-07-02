import type { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

export interface UniversityCreateInput {
  name: string;
  country: string;
  base_url: string;
  notes?: string | null;
}

export interface ListUniversitiesParams {
  cursor?: string;
  take?: number;
  search?: string;
  crawl_status?: string;
  orderBy?: "created_at" | "name" | "total_courses_extracted" | "sort_order";
  order?: "asc" | "desc";
}

export const universityRepository = {
  /** Next free sort_order so new rows append to the END of the manual order. */
  async nextSortOrder(): Promise<number> {
    const max = await prisma.university.aggregate({ _max: { sort_order: true } });
    return (max._max.sort_order ?? -1) + 1;
  },

  async create(input: UniversityCreateInput) {
    const sort_order = await this.nextSortOrder();
    return prisma.university.create({ data: { ...input, sort_order } });
  },

  /** Bulk insert, skipping rows that duplicate an existing (name, base_url). */
  async createMany(rows: UniversityCreateInput[]) {
    let sort_order = await this.nextSortOrder();
    const data = rows.map((r) => ({ ...r, sort_order: sort_order++ }));
    const result = await prisma.university.createMany({
      data,
      skipDuplicates: true,
    });
    return result.count;
  },

  /**
   * Persist a manual ordering: the array index becomes each row's sort_order, so
   * the Universities table AND the crawl pick them up in exactly this order.
   */
  async reorder(ids: string[]) {
    await prisma.$transaction(
      ids.map((id, i) => prisma.university.update({ where: { id }, data: { sort_order: i } })),
    );
    return { reordered: ids.length };
  },

  findById(id: string) {
    return prisma.university.findUnique({ where: { id } });
  },

  /**
   * Delete universities by id. Their discovered links, snapshots and course
   * criteria cascade-delete (schema onDelete: Cascade); crawl logs/jobs have their
   * university_id nulled (SetNull). Returns how many rows were removed.
   */
  async deleteMany(ids: string[]) {
    if (ids.length === 0) return 0;
    const { count } = await prisma.university.deleteMany({ where: { id: { in: ids } } });
    return count;
  },

  async list(params: ListUniversitiesParams = {}) {
    const take = Math.min(params.take ?? 25, 100);
    const where: Prisma.UniversityWhereInput = {};
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: "insensitive" } },
        { country: { contains: params.search, mode: "insensitive" } },
        { base_url: { contains: params.search, mode: "insensitive" } },
      ];
    }
    if (params.crawl_status) {
      where.crawl_status = params.crawl_status as Prisma.UniversityWhereInput["crawl_status"];
    }

    // Default to the MANUAL order (sort_order) so the table + crawl follow the
    // user's drag-to-reorder. A stable secondary key keeps ties deterministic.
    const field = params.orderBy ?? "sort_order";
    const dir = params.order ?? (field === "sort_order" ? "asc" : "desc");
    const items = await prisma.university.findMany({
      where,
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: [{ [field]: dir }, { created_at: "asc" }],
    });

    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
  },

  updateCrawlStatus(id: string, crawl_status: Prisma.UniversityUpdateInput["crawl_status"]) {
    return prisma.university.update({ where: { id }, data: { crawl_status } });
  },

  /** Universities with no website yet — candidates for auto-discovery. */
  findManyMissingBaseUrl(take = 1000) {
    return prisma.university.findMany({ where: { base_url: "" }, take, orderBy: { created_at: "asc" } });
  },

  updateBaseUrl(id: string, base_url: string) {
    return prisma.university.update({ where: { id }, data: { base_url } });
  },

  /**
   * Recompute a university's headline counters AUTHORITATIVELY from the real
   * tables, so they can never drift (the old per-event increments double-counted
   * across resumes/re-parses, producing nonsense like valid > links):
   *   total_links_found       = discovered links
   *   total_valid_links       = reachable links (HTTP 2xx/3xx)
   *   total_courses_extracted = DISTINCT eligibility/criteria URLs (the real deliverable count)
   */
  recomputeStats(universityId: string) {
    return prisma.$executeRawUnsafe(
      `UPDATE university u SET
         total_links_found = (SELECT count(*) FROM discovered_link dl WHERE dl.university_id = u.id),
         total_valid_links = (SELECT count(*) FROM discovered_link dl WHERE dl.university_id = u.id AND dl.http_status BETWEEN 200 AND 399),
         total_courses_extracted = (SELECT count(DISTINCT cc.criteria_url) FROM course_criteria cc WHERE cc.university_id = u.id)
       WHERE u.id = $1`,
      universityId,
    );
  },

  /** Recompute the counters for EVERY university (maintenance: fix existing drift). */
  recomputeAllStats() {
    return prisma.$executeRawUnsafe(
      `UPDATE university u SET
         total_links_found = (SELECT count(*) FROM discovered_link dl WHERE dl.university_id = u.id),
         total_valid_links = (SELECT count(*) FROM discovered_link dl WHERE dl.university_id = u.id AND dl.http_status BETWEEN 200 AND 399),
         total_courses_extracted = (SELECT count(DISTINCT cc.criteria_url) FROM course_criteria cc WHERE cc.university_id = u.id)`,
    );
  },

  incrementCounters(
    id: string,
    delta: Partial<{
      total_links_found: number;
      total_valid_links: number;
      total_courses_extracted: number;
    }>,
  ) {
    return prisma.university.update({
      where: { id },
      data: {
        ...(delta.total_links_found
          ? { total_links_found: { increment: delta.total_links_found } }
          : {}),
        ...(delta.total_valid_links
          ? { total_valid_links: { increment: delta.total_valid_links } }
          : {}),
        ...(delta.total_courses_extracted
          ? { total_courses_extracted: { increment: delta.total_courses_extracted } }
          : {}),
      },
    });
  },
};
