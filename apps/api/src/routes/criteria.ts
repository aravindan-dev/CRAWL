import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { criteriaRepository } from "@clg/database";
import { listQuery, HttpError } from "../lib/http.js";

const updateSchema = z.object({
  course_name: z.string().min(1).optional(),
  criteria: z.string().nullable().optional(),
  degree_level: z.enum(["Bachelor", "Diploma", "Other"]).optional(),
  required_subjects: z.array(z.string()).optional(),
  minimum_marks: z.string().nullable().optional(),
  entrance_exam: z.string().nullable().optional(),
  english_requirement: z.string().nullable().optional(),
});

export async function criteriaRoutes(app: FastifyInstance) {
  app.get("/criteria", async (req) => {
    const q = listQuery(req);
    return criteriaRepository.list({
      cursor: q.cursor,
      take: q.take,
      search: q.search,
      university_id: q["university_id"] as string | undefined,
      review_status: q["review_status"] as string | undefined,
      parser_type: q["parser_type"] as string | undefined,
      minConfidence: q["minConfidence"] !== undefined ? Number(q["minConfidence"]) : undefined,
      maxConfidence: q["maxConfidence"] !== undefined ? Number(q["maxConfidence"]) : undefined,
    });
  });

  app.get("/criteria/:id", async (req) => {
    const { id } = req.params as { id: string };
    const rec = await criteriaRepository.findById(id);
    if (!rec) throw new HttpError(404, "Record not found");
    return rec;
  });

  app.put("/criteria/:id", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid update", parsed.error.issues);
    // criteria_url and source_snippet are intentionally NOT editable here — the
    // URL invariant must never be overwritten by a human edit.
    return criteriaRepository.update(id, parsed.data);
  });

  app.post("/criteria/:id/approve", async (req) => {
    const { id } = req.params as { id: string };
    return criteriaRepository.setReview(id, "APPROVED", (req.body as { reviewer?: string })?.reviewer);
  });

  app.post("/criteria/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    return criteriaRepository.setReview(id, "REJECTED", (req.body as { reviewer?: string })?.reviewer);
  });

  app.post("/criteria/:id/needs-review", async (req) => {
    const { id } = req.params as { id: string };
    return criteriaRepository.setReview(id, "NEEDS_REVIEW", (req.body as { reviewer?: string })?.reviewer);
  });

  app.post("/criteria/bulk-approve", async (req) => {
    const parsed = z.object({ ids: z.array(z.string()).min(1), reviewer: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid payload", parsed.error.issues);
    const result = await criteriaRepository.bulkApprove(parsed.data.ids, parsed.data.reviewer);
    return { approved: result.count };
  });
}
