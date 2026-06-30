import type { FastifyInstance } from "fastify";
import { runMonitor, getMonitorProgress, getMonitorSummary } from "../services/monitorService.js";

/** Change-monitor endpoints (the recurring "keep data fresh" feature). */
export async function monitorRoutes(app: FastifyInstance) {
  app.post("/monitor/run", async () => runMonitor());
  app.get("/monitor/progress", async () => getMonitorProgress());
  app.get("/monitor/summary", async () => getMonitorSummary());
}
