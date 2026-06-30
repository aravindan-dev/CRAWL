// Side-effect import FIRST: loads the nearest .env into process.env before
// PrismaClient reads DATABASE_URL at construction time.
import "@clg/shared/env";
import { PrismaClient } from "@prisma/client";

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
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient } from "@prisma/client";
