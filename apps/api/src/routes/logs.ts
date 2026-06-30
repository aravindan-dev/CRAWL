import type { FastifyInstance } from "fastify";
import { logRepository } from "@clg/database";
import { listQuery } from "../lib/http.js";

export async function logRoutes(app: FastifyInstance) {
  app.get("/logs", async (req) => {
    const q = listQuery(req);
    return logRepository.list({
      cursor: q.cursor,
      take: q.take,
      university_id: q["university_id"] as string | undefined,
      action: q["action"] as string | undefined,
      status: q["status"] as string | undefined,
    });
  });
}
