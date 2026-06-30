import type { FastifyInstance } from "fastify";
import { jobRepository } from "@clg/database";
import { listQuery, HttpError } from "../lib/http.js";

export async function jobRoutes(app: FastifyInstance) {
  app.get("/jobs", async (req) => {
    const q = listQuery(req);
    return jobRepository.list({
      cursor: q.cursor,
      take: q.take,
      status: q["status"] as string | undefined,
      job_type: q["job_type"] as string | undefined,
    });
  });

  app.get("/jobs/:id", async (req) => {
    const { id } = req.params as { id: string };
    const job = await jobRepository.findById(id);
    if (!job) throw new HttpError(404, "Job not found");
    return job;
  });
}
