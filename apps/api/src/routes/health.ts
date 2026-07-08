import type { FastifyInstance } from "fastify";
import { prisma } from "@clg/database";
import { getLicenseStatus } from "../plugins/license.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    let db = "ok";
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = "down";
    }
    return {
      status: db === "ok" ? "ok" : "degraded",
      db,
      uptime: process.uptime(),
      license: getLicenseStatus().state,
    };
  });
}
