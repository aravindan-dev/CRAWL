// Side-effect import FIRST: loads the nearest .env into process.env before
// PrismaClient reads DATABASE_URL at construction time.
import "@clg/shared/env";
import { env } from "@clg/shared";
import { PrismaClient } from "@prisma/client";

/**
 * Prisma's default pool size (num_physical_cpus * 2 + 1) is sized for ONE
 * process doing modest concurrent work — it does NOT scale with
 * CRAWL_CONCURRENCY. Every parallel university crawl runs its own set of DB
 * writes (link upserts, batched discoveries, fingerprints), so at high
 * CRAWL_CONCURRENCY (10 on a 64GB box, 20-30 on 128-256GB) the default pool
 * becomes the bottleneck: queries queue behind a handful of connections
 * regardless of how much CPU/RAM/browser capacity is free. Scale the pool
 * with it (clamped so a 1-2 concurrency dev box isn't over-provisioned and a
 * huge box doesn't exceed Postgres's own max_connections — see
 * docker-compose.yml's matching bump).
 */
function withPoolSize(url: string): string {
  if (/[?&]connection_limit=/.test(url)) return url; // explicit override wins
  // Size for the MAXIMUM concurrency this process may reach. With adaptive
  // concurrency the worker can scale up to CRAWL_CONCURRENCY_MAX at runtime, and
  // the pool is fixed at construction — so provision for the ceiling now, or a
  // scale-up would queue every query behind too few connections (DB-connection
  // protection).
  const peakConcurrency = env.CRAWL_ADAPTIVE_CONCURRENCY
    ? Math.max(env.CRAWL_CONCURRENCY, env.CRAWL_CONCURRENCY_MAX)
    : env.CRAWL_CONCURRENCY;
  const limit = Math.min(150, Math.max(10, 8 + peakConcurrency * 6));
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=${limit}`;
}

/**
 * Single shared PrismaClient. In dev (tsx watch / Next HMR) we cache it on the
 * global to avoid exhausting connections across reloads.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
    datasources: { db: { url: withPoolSize(env.DATABASE_URL) } },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient } from "@prisma/client";
