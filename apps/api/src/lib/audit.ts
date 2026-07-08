import type { FastifyRequest } from "fastify";
import { auditLogRepository } from "@clg/database";
import type { AuthUser } from "../plugins/auth.js";

/** Fire-and-forget audit trail write. Never throws into the caller's request. */
export function audit(req: FastifyRequest, action: string, detail?: string, actor?: AuthUser): void {
  const user = actor ?? req.user;
  void auditLogRepository
    .write({
      user_id: user?.id ?? null,
      username: user?.username ?? "unknown",
      action,
      detail: detail ?? null,
      ip: req.ip,
    })
    .catch(() => {
      /* audit logging must never break the request it's recording */
    });
}
