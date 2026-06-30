import type { FastifyInstance } from "fastify";
import { prisma } from "@clg/database";
import { getExportCounts } from "../services/crawlAdminService.js";

/** Dashboard Home stat cards (Section 35). */
export async function statsRoutes(app: FastifyInstance) {
  app.get("/stats", async () => {
    const [
      universities,
      links,
      validLinks,
      failedLinks,
      criteriaByStatus,
      totalCourses,
    ] = await Promise.all([
      prisma.university.count(),
      prisma.discoveredLink.count(),
      prisma.discoveredLink.count({
        where: {
          status: {
            in: ["VALID_COURSE_PAGE", "VALID_ADMISSION_PAGE", "POSSIBLE_REQUIREMENT_PAGE"],
          },
        },
      }),
      prisma.discoveredLink.count({ where: { status: { in: ["BROKEN_LINK", "BLOCKED"] } } }),
      prisma.courseCriteria.groupBy({ by: ["review_status"], _count: { _all: true } }),
      prisma.courseCriteria.count(),
    ]);

    const byStatus: Record<string, number> = {};
    for (const g of criteriaByStatus) byStatus[g.review_status] = g._count._all;

    // Prefer the VERIFIED deliverable totals (browser-revalidated, de-duplicated rows
    // in the FINAL export files) so the headline numbers match what actually ships.
    // Fall back to the live DB counters before the first export exists.
    const ex = getExportCounts();
    const verifiedValid = ex.universityUrls + ex.courseUrls;

    return {
      total_universities: universities,
      total_links_discovered: links,
      total_valid_links: verifiedValid > 0 ? verifiedValid : validLinks,
      failed_links: failedLinks,
      total_courses_extracted: ex.courseUrls > 0 ? ex.courseUrls : totalCourses,
      pending_review: (byStatus.PENDING ?? 0) + (byStatus.LOW_CONFIDENCE ?? 0) + (byStatus.NEEDS_REVIEW ?? 0),
      approved: byStatus.APPROVED ?? 0,
      rejected: byStatus.REJECTED ?? 0,
      by_review_status: byStatus,
    };
  });
}
