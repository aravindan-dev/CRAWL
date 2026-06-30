import { env, logger, loadEnv } from "@clg/shared";
import { prisma } from "@clg/database";
import { closeRedisConnection } from "@clg/queue";
import { buildApp } from "./app.js";
import { startCrawler, getCrawlerState } from "./services/crawlerControlService.js";
import { checkLicenseOnStartup, enforcementEnabled } from "./services/licenseService.js";

async function main() {
  loadEnv();

  // LICENSE GATE — the product is licensed, not sold. In packaged builds
  // (LICENSE_ENFORCE=true) refuse to start without a valid, in-date, machine-bound
  // license. In dev this only warns so the source runs without a license file.
  const lic = checkLicenseOnStartup();
  if (enforcementEnabled() && !lic.valid) {
    logger.error(
      { reason: lic.reason, machineId: lic.machine },
      "Startup blocked: a valid license is required. Send the Machine ID above to your vendor to obtain license.dat.",
    );
    process.exit(2);
  }

  const app = await buildApp();
  const port = env.API_PORT;

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "API listening");

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
