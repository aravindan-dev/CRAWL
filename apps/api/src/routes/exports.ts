import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { repoRoot } from "@clg/shared";
import { exportRepository } from "@clg/database";
import { listQuery, HttpError } from "../lib/http.js";
import { runExport, ExportAbortError } from "../services/exportService.js";

const exportSchema = z.object({
  scope: z
    .enum(["approved_only", "all", "low_confidence", "by_university", "by_date"])
    .default("approved_only"),
  university_id: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
});

export async function exportRoutes(app: FastifyInstance) {
  const handle = (format: "csv" | "excel") => async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = exportSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, "Invalid export request", parsed.error.issues);
    try {
      const outcome = await runExport({ ...parsed.data, format });
      return reply.send(outcome);
    } catch (err) {
      if (err instanceof ExportAbortError) {
        // Export gate blocked the request — return the offending IDs (Section 4, Level 5).
        return reply.code(422).send({
          error: "EXPORT_BLOCKED",
          message: err.message,
          abortIds: err.abortIds,
          warnings: err.warnings,
        });
      }
      throw err;
    }
  };

  app.post("/exports/csv", handle("csv"));
  app.post("/exports/excel", handle("excel"));

  app.get("/exports", async (req) => {
    const q = listQuery(req);
    return exportRepository.list({ cursor: q.cursor, take: q.take });
  });

  app.get("/exports/:id/download", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await exportRepository.findById(id);
    if (!row) throw new HttpError(404, "Export not found");
    const full = resolve(repoRoot(), row.file_path);
    const filename = row.file_path.split("/").pop() ?? "export";
    reply.header("content-disposition", `attachment; filename="${filename}"`);
    reply.type(row.export_type === "EXCEL"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "text/csv");
    return reply.send(createReadStream(full));
  });
}
