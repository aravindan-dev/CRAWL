import type { FastifyInstance } from "fastify";
import { licenseStatus } from "../services/licenseService.js";

export async function licenseRoutes(app: FastifyInstance) {
  // Lets the dashboard show "Licensed to <company>, expires …" and the Machine
  // ID a customer needs to send the vendor for activation. Never returns the token.
  app.get("/license/status", async () => licenseStatus());
}
