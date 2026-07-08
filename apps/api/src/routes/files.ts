import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { repoRoot } from "@clg/shared";
import { HttpError } from "../lib/http.js";

export const EXPORTS_ROOT = resolve(repoRoot(), "storage", "exports");

const CONTENT_TYPES: Record<string, string> = {
  ".csv": "text/csv; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Resolves a requested path against `root` and confirms it didn't escape via
 * `..`. Pure + exported so the guard itself is unit-testable without a
 * running server (see files.test.ts).
 */
export function resolveWithinRoot(root: string, requested: string): string | null {
  const resolved = resolve(root, requested);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

/**
 * Authenticated export downloads (VIEWER+, enforced by the global auth gate's
 * default GET rule). Replaces direct static exposure of storage/exports so a
 * download always requires a session, and resolves + prefix-checks the path
 * itself rather than trusting @fastify/static's own traversal handling.
 */
export async function fileRoutes(app: FastifyInstance) {
  app.get("/files/*", async (req, reply) => {
    const requested = (req.params as { "*": string })["*"] ?? "";
    const resolved = resolveWithinRoot(EXPORTS_ROOT, requested);

    if (!resolved) throw new HttpError(400, "Invalid file path.");
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new HttpError(404, "That file wasn't found. It may not have been generated yet.");
    }

    const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const filename = resolved.split(/[/\\]/).pop() ?? "download";
    reply.header("content-type", contentType);
    reply.header("content-disposition", `attachment; filename="${filename}"`);
    return reply.send(createReadStream(resolved));
  });
}
