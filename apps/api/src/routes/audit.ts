import type { FastifyInstance } from "fastify";
import { auditLogRepository } from "@clg/database";
import { listQuery } from "../lib/http.js";

/** ADMIN-only, enforced centrally by the auth gate. */
export async function auditRoutes(app: FastifyInstance) {
  app.get("/audit", async (req) => {
    const q = listQuery(req);
    return auditLogRepository.list({ cursor: q.cursor, take: q.take as number | undefined });
  });
}
