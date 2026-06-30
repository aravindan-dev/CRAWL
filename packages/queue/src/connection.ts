import { Redis } from "ioredis";
import { env } from "@clg/shared/env";

/**
 * Shared ioredis connection for BullMQ. BullMQ requires
 * `maxRetriesPerRequest: null` on the connection used by workers/blocking ops.
 */
let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }
  return connection;
}

export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
