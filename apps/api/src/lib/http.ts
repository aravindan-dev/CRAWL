import type { FastifyRequest } from "fastify";

/** Parse common list query params (cursor pagination + filters). */
export function listQuery(req: FastifyRequest): {
  cursor?: string;
  take?: number;
  search?: string;
  [k: string]: string | number | undefined;
} {
  const q = req.query as Record<string, string | undefined>;
  const out: Record<string, string | number | undefined> = { ...q };
  if (q.take) out.take = Number(q.take);
  return out as ReturnType<typeof listQuery>;
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public details?: unknown) {
    super(message);
  }
}
