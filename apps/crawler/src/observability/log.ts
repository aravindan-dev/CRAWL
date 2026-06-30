import { logRepository, type CrawlAction, type LogStatus } from "@clg/database";
import { logger } from "@clg/shared";

export interface ActionLog {
  university_id?: string | null;
  discovered_link_id?: string | null;
  action: CrawlAction;
  status: LogStatus;
  message?: string;
  duration_ms?: number;
  error_stack?: string;
}

/** Write a durable CrawlLog row + emit a console log. Never throws (logging
 *  must not break the pipeline). */
export async function logAction(entry: ActionLog): Promise<void> {
  const level = entry.status === "ERROR" ? "error" : entry.status === "WARN" ? "warn" : "debug";
  logger[level](
    {
      action: entry.action,
      university_id: entry.university_id,
      link_id: entry.discovered_link_id,
      duration_ms: entry.duration_ms,
    },
    entry.message ?? entry.action,
  );
  try {
    await logRepository.write({
      university_id: entry.university_id ?? null,
      discovered_link_id: entry.discovered_link_id ?? null,
      action: entry.action,
      status: entry.status,
      message: entry.message ?? null,
      duration_ms: entry.duration_ms ?? null,
      error_stack: entry.error_stack ?? null,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "failed to persist crawl log");
  }
}

/** Run `fn`, logging its duration and any error under `action`. */
export async function timed<T>(
  action: CrawlAction,
  ctx: { university_id?: string | null; discovered_link_id?: string | null; message?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    await logAction({ ...ctx, action, status: "OK", duration_ms: Date.now() - start });
    return result;
  } catch (err) {
    await logAction({
      ...ctx,
      action,
      status: "ERROR",
      duration_ms: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
      error_stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
}
