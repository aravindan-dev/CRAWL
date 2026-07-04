import type { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

export interface UpsertDiscoveredLinkInput {
  university_id: string;
  url: string;
  url_hash: string;
  canonical_url?: string;
  link_text?: string | null;
  link_score?: number;
  depth?: number;
  status?: Prisma.DiscoveredLinkCreateInput["status"];
  /** The crawl context that discovered this link. Rows are unique per
   *  (university, url_hash, context) so contexts never share crawl state. */
  crawl_context?: Prisma.DiscoveredLinkCreateInput["crawl_context"];
  /** Deterministic pre-fetch URL classification (crawl authorization input). */
  page_class?: Prisma.DiscoveredLinkCreateInput["page_class"];
}

export interface ListLinksParams {
  cursor?: string;
  take?: number;
  university_id?: string;
  status?: string;
  minScore?: number;
  search?: string;
}

export const linkRepository = {
  /**
   * Resume state for a university crawl: which page URLs were already VISITED
   * (so a restart can skip them) and which are still PENDING (the frontier to
   * continue from). A link counts as visited once it has an http_status. This is
   * how "stop then resume exactly where it left off" works — it's DB-driven, so
   * it survives engine restarts / crashes.
   */
  async resumeState(
    university_id: string,
    crawl_context: Prisma.DiscoveredLinkWhereInput["crawl_context"],
  ): Promise<{ done: Set<string>; pending: { url: string; text: string; score: number }[] }> {
    // Context-scoped: an ELIGIBILITY resume must never treat the SCHOLARSHIP
    // crawl's visits as its own progress (and vice versa) — each context owns
    // its rows via the (university, url_hash, context) uniqueness.
    const rows = await prisma.discoveredLink.findMany({
      where: { university_id, crawl_context },
      select: { url: true, canonical_url: true, final_url: true, http_status: true, status: true, link_text: true, link_score: true },
    });
    const done = new Set<string>();
    const pending: { url: string; text: string; score: number }[] = [];
    for (const r of rows) {
      const visited = r.http_status !== null;
      if (visited) {
        if (r.canonical_url) done.add(r.canonical_url);
        if (r.final_url) done.add(r.final_url);
        done.add(r.url);
      } else if (r.status !== "PDF_DEFERRED" && r.status !== "REJECTED_CROSS_CONTEXT" && r.status !== "DUPLICATE") {
        // Cross-context rejections and duplicates (older year-editions / alias
        // URLs) are terminal — a resume must never re-queue them.
        pending.push({ url: r.url, text: r.link_text ?? "", score: r.link_score ?? 0 });
      }
    }
    // Highest-scoring pending first so the most relevant pages resume first.
    pending.sort((a, b) => b.score - a.score);
    return { done, pending };
  },

  /**
   * Insert a discovered link if (university_id, url_hash) is new. Returns the
   * row (existing or created). Idempotent — safe to call repeatedly while
   * crawling, which is how dedupe-on-discovery works.
   */
  async upsert(input: UpsertDiscoveredLinkInput) {
    const crawl_context = input.crawl_context ?? "ELIGIBILITY";
    return prisma.discoveredLink.upsert({
      where: {
        university_id_url_hash_crawl_context: {
          university_id: input.university_id,
          url_hash: input.url_hash,
          crawl_context,
        },
      },
      create: {
        university_id: input.university_id,
        url: input.url,
        url_hash: input.url_hash,
        canonical_url: input.canonical_url ?? input.url,
        link_text: input.link_text ?? null,
        link_score: input.link_score ?? 0,
        depth: input.depth ?? 0,
        status: input.status ?? "PENDING",
        crawl_context,
        page_class: input.page_class ?? null,
      },
      // Keep the latest score/classification if the same URL is rediscovered.
      update: {
        ...(input.link_score !== undefined ? { link_score: input.link_score } : {}),
        ...(input.page_class !== undefined ? { page_class: input.page_class } : {}),
      },
    });
  },

  /**
   * Batch-insert many discovered links in ONE query (skips duplicates by
   * (university_id, url_hash)). Replaces hundreds of per-link upserts per page —
   * the crawl's main throughput bottleneck. Returns how many were newly inserted.
   */
  async createManyDiscovered(
    rows: {
      university_id: string;
      url: string;
      url_hash: string;
      canonical_url: string;
      link_text: string | null;
      link_score: number;
      depth: number;
      status: Prisma.DiscoveredLinkCreateInput["status"];
      crawl_context: Prisma.DiscoveredLinkCreateInput["crawl_context"];
      page_class?: Prisma.DiscoveredLinkCreateInput["page_class"];
      error_message?: string | null;
    }[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const r = await prisma.discoveredLink.createMany({ data: rows, skipDuplicates: true });
    return r.count;
  },

  findById(id: string) {
    return prisma.discoveredLink.findUnique({ where: { id } });
  },

  /**
   * LIVE "Validated URLs" feed for the Crawl & Validate page: links the engine
   * content-verified during the crawl (single pass), newest first, joined to the
   * university name/country so the dashboard can show each URL one-by-one as it is
   * found — no export file needed (this is straight from the DB, live).
   */
  listValidated(params: { take?: number; university_id?: string } = {}) {
    const take = Math.min(params.take ?? 200, 1000);
    return prisma.discoveredLink.findMany({
      where: {
        content_verified: true,
        ...(params.university_id ? { university_id: params.university_id } : {}),
      },
      take,
      orderBy: { updated_at: "desc" },
      select: {
        id: true,
        url: true,
        final_url: true,
        eligibility_url: true,
        page_title: true,
        link_text: true,
        http_status: true,
        status: true,
        evidence: true,
        updated_at: true,
        university: { select: { id: true, name: true, country: true } },
      },
    });
  },

  /** Same as listValidated but scoped to one university (per-university drawer). */
  validatedForUniversity(university_id: string, take = 500) {
    return this.listValidated({ take, university_id });
  },

  update(id: string, data: Prisma.DiscoveredLinkUpdateInput) {
    return prisma.discoveredLink.update({ where: { id }, data });
  },

  /** Links queued for extraction (score >= threshold), ordered by score. */
  queuedForExtraction(university_id: string, minScore: number, take = 100) {
    return prisma.discoveredLink.findMany({
      where: { university_id, link_score: { gte: minScore }, status: "QUEUED" },
      orderBy: { link_score: "desc" },
      take,
    });
  },

  async list(params: ListLinksParams = {}) {
    const take = Math.min(params.take ?? 25, 100);
    const where: Prisma.DiscoveredLinkWhereInput = {};
    if (params.university_id) where.university_id = params.university_id;
    if (params.status) where.status = params.status as Prisma.DiscoveredLinkWhereInput["status"];
    if (params.minScore !== undefined) where.link_score = { gte: params.minScore };
    if (params.search) {
      where.OR = [
        { url: { contains: params.search, mode: "insensitive" } },
        { page_title: { contains: params.search, mode: "insensitive" } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.discoveredLink.findMany({
        where,
        take: take + 1,
        ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
        orderBy: { created_at: "desc" },
        // Pull the best extracted course name so the UI can show a real programme
        // name (e.g. "Bachelor of Nursing") instead of a bare subject code.
        include: {
          course_criteria: {
            select: { course_name: true, degree_level: true },
            orderBy: { confidence_score: "desc" },
            take: 1,
          },
        },
      }),
      prisma.discoveredLink.count({ where }),
    ]);
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null, total };
  },

  /**
   * Bot-protected / blocked attempts with the exact university + course context
   * so the dashboard can show precisely which page/university/course was tried.
   */
  async listBlocked(take = 300) {
    return prisma.discoveredLink.findMany({
      where: { status: "BLOCKED" },
      take,
      orderBy: { updated_at: "desc" },
      select: {
        id: true,
        url: true,
        final_url: true,
        page_title: true,
        http_status: true,
        error_message: true,
        retry_count: true,
        link_score: true,
        updated_at: true,
        university: { select: { name: true, country: true, base_url: true } },
        course_criteria: { select: { course_name: true, degree_level: true }, take: 5 },
      },
    });
  },

  failedRetryable(university_id?: string, take = 100) {
    return prisma.discoveredLink.findMany({
      where: {
        status: "BROKEN_LINK",
        retry_count: { lt: 3 },
        ...(university_id ? { university_id } : {}),
      },
      take,
    });
  },
};
