export { prisma } from "./client.js";
export type { PrismaClient } from "./client.js";
export * from "./repositories/index.js";

// Re-export Prisma's generated types + enums so consumers depend only on
// @clg/database, never on @prisma/client directly.
export {
  Prisma,
  CrawlStatus,
  LinkStatus,
  ReviewStatus,
  DegreeLevel,
  ParserType,
  JobType,
  JobStatus,
  CrawlAction,
  LogStatus,
  ExportType,
} from "@prisma/client";
export type {
  University,
  DiscoveredLink,
  PageSnapshot,
  CourseCriteria,
  CrawlLog,
  CrawlJob,
  Export,
} from "@prisma/client";
