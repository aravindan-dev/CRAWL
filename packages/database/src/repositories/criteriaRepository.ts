import type { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

export interface ListCriteriaParams {
  cursor?: string;
  take?: number;
  university_id?: string;
  review_status?: string;
  parser_type?: string;
  minConfidence?: number;
  maxConfidence?: number;
  search?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}

export const criteriaRepository = {
  /**
   * Upsert on the dedup key (university_id, canonical_course_key, criteria_url).
   * The DB also enforces the criteria_url CHECK constraint, so a missing/invalid
   * URL is rejected here regardless of caller behavior.
   */
  upsertByDedupKey(data: Prisma.CourseCriteriaUncheckedCreateInput) {
    return prisma.courseCriteria.upsert({
      where: {
        university_id_canonical_course_key_criteria_url: {
          university_id: data.university_id,
          canonical_course_key: data.canonical_course_key,
          criteria_url: data.criteria_url,
        },
      },
      create: data,
      update: {
        // Keep the higher-confidence version on rediscovery.
        confidence_score: data.confidence_score,
        criteria: data.criteria,
        source_snippet: data.source_snippet,
        required_subjects: data.required_subjects,
        minimum_marks: data.minimum_marks,
        entrance_exam: data.entrance_exam,
        english_requirement: data.english_requirement,
        review_status: data.review_status,
        parser_type: data.parser_type,
      },
    });
  },

  findById(id: string) {
    return prisma.courseCriteria.findUnique({
      where: { id },
      include: { discovered_link: { select: { screenshot_path: true, final_url: true } } },
    });
  },

  findByDedupKey(university_id: string, canonical_course_key: string, criteria_url: string) {
    return prisma.courseCriteria.findUnique({
      where: {
        university_id_canonical_course_key_criteria_url: {
          university_id,
          canonical_course_key,
          criteria_url,
        },
      },
    });
  },

  update(id: string, data: Prisma.CourseCriteriaUpdateInput) {
    return prisma.courseCriteria.update({ where: { id }, data });
  },

  setReview(id: string, review_status: Prisma.CourseCriteriaUpdateInput["review_status"], reviewer?: string) {
    return prisma.courseCriteria.update({
      where: { id },
      data: { review_status, reviewed_by: reviewer ?? null, reviewed_at: new Date() },
    });
  },

  bulkApprove(ids: string[], reviewer?: string) {
    return prisma.courseCriteria.updateMany({
      where: { id: { in: ids } },
      data: { review_status: "APPROVED", reviewed_by: reviewer ?? null, reviewed_at: new Date() },
    });
  },

  buildWhere(params: ListCriteriaParams): Prisma.CourseCriteriaWhereInput {
    const where: Prisma.CourseCriteriaWhereInput = {};
    if (params.university_id) where.university_id = params.university_id;
    if (params.review_status)
      where.review_status = params.review_status as Prisma.CourseCriteriaWhereInput["review_status"];
    if (params.parser_type)
      where.parser_type = params.parser_type as Prisma.CourseCriteriaWhereInput["parser_type"];
    if (params.minConfidence !== undefined || params.maxConfidence !== undefined) {
      where.confidence_score = {
        ...(params.minConfidence !== undefined ? { gte: params.minConfidence } : {}),
        ...(params.maxConfidence !== undefined ? { lte: params.maxConfidence } : {}),
      };
    }
    if (params.createdAfter || params.createdBefore) {
      where.created_at = {
        ...(params.createdAfter ? { gte: params.createdAfter } : {}),
        ...(params.createdBefore ? { lte: params.createdBefore } : {}),
      };
    }
    if (params.search) {
      where.OR = [
        { course_name: { contains: params.search, mode: "insensitive" } },
        { university_name: { contains: params.search, mode: "insensitive" } },
        { criteria: { contains: params.search, mode: "insensitive" } },
      ];
    }
    return where;
  },

  async list(params: ListCriteriaParams = {}) {
    const take = Math.min(params.take ?? 25, 100);
    const where = this.buildWhere(params);
    const items = await prisma.courseCriteria.findMany({
      where,
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: { created_at: "desc" },
      include: { discovered_link: { select: { screenshot_path: true } } },
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
  },

  /** Materialize all records matching a filter (for export). */
  findAllForExport(params: ListCriteriaParams = {}) {
    return prisma.courseCriteria.findMany({
      where: this.buildWhere(params),
      orderBy: { created_at: "desc" },
    });
  },

  counts() {
    return prisma.courseCriteria.groupBy({
      by: ["review_status"],
      _count: { _all: true },
    });
  },
};
