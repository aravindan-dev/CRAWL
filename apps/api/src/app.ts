import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { logger, repoRoot, humanizeError } from "@clg/shared";
import { HttpError } from "./lib/http.js";
import { healthRoutes } from "./routes/health.js";
import { statsRoutes } from "./routes/stats.js";
import { universityRoutes } from "./routes/universities.js";
import { linkRoutes } from "./routes/links.js";
import { criteriaRoutes } from "./routes/criteria.js";
import { exportRoutes } from "./routes/exports.js";
import { logRoutes } from "./routes/logs.js";
import { jobRoutes } from "./routes/jobs.js";
import { configRoutes } from "./routes/config.js";
import { opsRoutes } from "./routes/ops.js";
import { coverageRoutes } from "./routes/coverage.js";
import { monitorRoutes } from "./routes/monitor.js";
import { licenseRoutes } from "./routes/license.js";

/** Build the Fastify app (exported for tests). */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 15 * 1024 * 1024 });

  // --- Security headers (local-first hardening) -----------------------------
  // CSP is intentionally disabled here (this API serves JSON + binary artifacts,
  // not HTML — CSP belongs on the web app). Cross-origin resource policy is
  // relaxed so the dashboard (localhost:3100) can still load screenshot
  // artifacts served from this origin (localhost:4100).
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // HSTS is meaningless over local http; avoid sending it.
    hsts: false,
  });

  // Defence-in-depth: cap request volume per client (single-user tool, generous).
  await app.register(rateLimit, {
    global: true,
    max: 1200,
    timeWindow: "1 minute",
    allowList: ["127.0.0.1", "::1"],
  });

  // CORS restricted to local origins only — the dashboard is served from
  // localhost, so reject requests originating from any remote site.
  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser clients (curl, same-origin) send no Origin header — allow.
      if (!origin) return cb(null, true);
      try {
        const { hostname } = new URL(origin);
        const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
        return cb(null, local);
      } catch {
        return cb(null, false);
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });

  // Serve crawl proof artifacts (screenshots/html/text) at /artifacts/*.
  await app.register(fastifyStatic, {
    root: resolve(repoRoot(), "storage"),
    prefix: "/artifacts/",
    decorateReply: false,
  });

  // Serve the Aliff input files (separate module) for download from the dashboard.
  await app.register(fastifyStatic, {
    root: resolve(repoRoot(), "tools", "aliff-automation", "data"),
    prefix: "/aliff-data/",
    decorateReply: false,
  });

  // Accept raw text/csv bodies for the bulk endpoint.
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_req, body, done) => done(null, body));

  // Tolerant JSON parser: an empty body (common for bodyless action POSTs like
  // /crawl, /approve) parses to {} instead of Fastify's "Body cannot be empty".
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const str = (body as string) ?? "";
    if (str.trim() === "") return done(null, {});
    try {
      done(null, JSON.parse(str));
    } catch (err) {
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    }
    // Respect an error's own statusCode (e.g. Fastify 4xx) instead of masking as 500.
    const statusCode =
      err && typeof err === "object" && "statusCode" in err && typeof err.statusCode === "number"
        ? err.statusCode
        : 500;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    if (statusCode >= 500) logger.error({ err: message, stack }, "unhandled API error");
    // Always return a clear, human-readable message (never a raw stack/code).
    return reply.code(statusCode).send({ error: humanizeError(err) });
  });

  await app.register(healthRoutes);
  await app.register(statsRoutes);
  await app.register(universityRoutes);
  await app.register(linkRoutes);
  await app.register(criteriaRoutes);
  await app.register(exportRoutes);
  await app.register(logRoutes);
  await app.register(jobRoutes);
  await app.register(configRoutes);
  await app.register(opsRoutes);
  await app.register(coverageRoutes);
  await app.register(monitorRoutes);
  await app.register(licenseRoutes);

  return app;
}
