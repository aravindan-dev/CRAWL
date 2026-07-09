import { prisma } from "../client.js";

export interface AuditLogInput {
  user_id?: string | null;
  username: string;
  action: string;
  detail?: string | null;
  ip?: string | null;
}

export interface ListAuditLogParams {
  cursor?: string;
  take?: number;
}

export const auditLogRepository = {
  write(input: AuditLogInput) {
    return prisma.auditLog.create({
      data: {
        user_id: input.user_id ?? null,
        username: input.username,
        action: input.action,
        detail: input.detail ?? null,
        ip: input.ip ?? null,
      },
    });
  },

  async list(params: ListAuditLogParams = {}) {
    const take = Math.min(params.take ?? 50, 200);
    const items = await prisma.auditLog.findMany({
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: { at: "desc" },
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
  },
};
