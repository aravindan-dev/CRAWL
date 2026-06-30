import type { FastifyInstance } from "fastify";
import { HttpError } from "../lib/http.js";
import {
  coverageSummary,
  computeCoverage,
  reviewQueue,
  setCourseStatus,
  autoResolve,
  aiAutoReview,
  getAiProgress,
  predictUrls,
  getPredictProgress,
  searchFallback,
  getSearchProgress,
  resolveExactUrls,
  getResolveProgress,
  exportCoverage,
  type CourseStatus,
} from "../services/coverageService.js";

const VALID: CourseStatus[] = ["FOUND", "SHARED", "NEEDS_REVIEW", "NOT_FOUND"];

/** Coverage Reconciliation — per-university completion report + review queue. */
export async function coverageRoutes(app: FastifyInstance) {
  app.get("/coverage", async () => coverageSummary());
  app.get("/coverage/university/:id", async (req) => {
    const { id } = req.params as { id: string };
    const [u] = await computeCoverage(id);
    if (!u) throw new HttpError(404, "University not found");
    return u;
  });
  app.get("/coverage/review", async () => reviewQueue());
  app.post("/coverage/:linkId/status", async (req) => {
    const { linkId } = req.params as { linkId: string };
    const body = (req.body ?? {}) as { status?: CourseStatus };
    if (!body.status || !VALID.includes(body.status)) throw new HttpError(400, `status must be one of ${VALID.join(", ")}`);
    return setCourseStatus(linkId, body.status);
  });
  app.post("/coverage/auto-resolve", async () => autoResolve());
  app.post("/coverage/ai-review", async () => aiAutoReview());
  app.get("/coverage/ai-progress", async () => getAiProgress());
  app.post("/coverage/predict-urls", async () => predictUrls());
  app.get("/coverage/predict-progress", async () => getPredictProgress());
  app.post("/coverage/search-fallback", async () => searchFallback());
  app.get("/coverage/search-progress", async () => getSearchProgress());
  app.post("/coverage/resolve-exact", async () => resolveExactUrls());
  app.get("/coverage/resolve-progress", async () => getResolveProgress());
  app.post("/coverage/export", async () => exportCoverage());
}
