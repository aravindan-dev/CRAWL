import pino from "pino";

/**
 * Structured application logger. JSON in production, pretty in dev when
 * `pino-pretty` is available. This is the process/console logger — durable
 * per-stage crawl logs go to the CrawlLog table via the database package.
 */
const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");

export const logger = pino({
  level,
  base: { service: process.env.SERVICE_NAME ?? "clg" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

export type Logger = typeof logger;
