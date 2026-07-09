import { env, logger, loadEnv } from "@clg/shared";
import { prisma } from "@clg/database";
import { closeRedisConnection } from "@clg/queue";
import { buildApp } from "./app.js";
import { startCrawler, getCrawlerState } from "./services/crawlerControlService.js";
import { startStallWatchdog } from "./services/crawlStallWatchdog.js";
import { getLicenseStatus } from "./plugins/license.js";

async function main() {
  loadEnv();

  // LICENSE — the product is licensed, not sold. Unlike the crawler workers, the
  // API always boots even with an invalid/missing license, so the dashboard can
  // show the lock screen and let the customer activate without a restart. Every
  // business route is rejected by the license gate plugin (plugins/license.ts)
  // until the license is valid or in its grace period.
  const lic = getLicenseStatus();
  if (lic.state === "invalid") {
    logger.warn({ code: lic.code, reason: lic.message }, "license invalid — dashboard will show the lock screen");
  } else if (lic.state === "grace") {
    logger.warn({ graceDaysLeft: lic.graceDaysLeft }, "license expired — running in grace period");
  } else {
    logger.info({ customer: lic.payload.customerName, daysLeft: lic.daysLeft }, "license OK");
  }

  const app = await buildApp();
  const port = env.API_PORT;
  // Shared server deployments need every office PC to reach this API, so the
  // default binds every interface (0.0.0.0). Set HOST=127.0.0.1 in .env for a
  // single-PC install that should never be reachable from the LAN.
  const host = process.env.HOST ?? "0.0.0.0";

  await app.listen({ port, host });
  logger.info({ port, host }, "API listening");

  // Auto-start the crawl engine so `start.bat` only needs to launch API + Web
  // (the API owns the single engine; the dashboard can Stop/Restart it). Skips
  // if an engine is already running (heartbeat lock) to avoid duplicate workers.
  // Set AUTO_START_CRAWLER=false to manage the engine purely from the dashboard.
  if (process.env.AUTO_START_CRAWLER !== "false") {
    setTimeout(() => {
      try {
        if (!getCrawlerState().running) { startCrawler(); logger.info("crawl engine auto-started"); }
      } catch (err) { logger.error({ err: String(err) }, "failed to auto-start crawl engine"); }
    }, 1500);
  }

  // SELF-HEAL: watch for a stalled crawl (engine running but no pages for a while —
  // the lost-job-after-crash case) and auto re-enqueue so it resumes on its own.
  if (process.env.AUTO_RECOVER_CRAWL !== "false") startStallWatchdog();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down API…");
    await app.close();
    await closeRedisConnection();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: String(err) }, "API failed to start");
  process.exit(1);
});
