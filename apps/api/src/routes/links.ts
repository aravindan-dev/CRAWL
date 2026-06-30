import type { FastifyInstance } from "fastify";
import { linkRepository } from "@clg/database";
import { listQuery, HttpError } from "../lib/http.js";
import { revalidateLink, revalidateAll, getRevalidateProgress } from "../services/linkValidationService.js";

// A course/programme page lives under the site's course catalog path. Same rule the
// recheck/export step uses to split university-level vs course-level URLs.
const COURSE_URL = /\/(courses?|programmes?|programs?|degrees?)\/[a-z0-9]/i;
const GENERIC_SLUG = /^(courses?|programmes?|programs?|degrees?|study|undergraduate|postgraduate|ug|pg|en|international|admissions?|entry-requirements?|how-to-apply)$/i;

/** Cheap course-name guess from the page title (before the site name) or URL slug. */
function deriveCourseName(title: string | null | undefined, url: string): string {
  const t = (title ?? "").split("|")[0]!.split(" - ")[0]!.trim();
  if (t.length >= 3 && !/^(home|search|courses?|programmes?|overview|not found|404)$/i.test(t)) return t;
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean).map((s) => s.replace(/\.(html?|php|aspx)$/i, ""));
    const pick = [...segs].reverse().find((s) => /[a-z]{3,}/i.test(s) && !GENERIC_SLUG.test(s));
    return pick ? pick.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() : "";
  } catch {
    return "";
  }
}

// Crawl statuses that mean the real browser successfully LOADED the page.
const BROWSER_LOADED = new Set([
  "VALID_COURSE_PAGE", "VALID_ADMISSION_PAGE", "POSSIBLE_REQUIREMENT_PAGE", "LOW_CONFIDENCE_PAGE", "NOT_RELEVANT", "REDIRECTED",
]);

/** Live verdict from the crawl-time HTTP status (no re-fetch — this is the feed). */
function verdictFor(http: number | null, status: string): string {
  if (http !== null && http >= 200 && http < 400) return "WORKING";
  if (http === 404 || http === 410) return "BROKEN";
  return BROWSER_LOADED.has(status) ? "BROWSER_VERIFIED" : "UNCONFIRMED";
}

export async function linkRoutes(app: FastifyInstance) {
  // LIVE "Validated URLs" feed for the Crawl & Validate page: links the engine
  // content-verified DURING the crawl (single pass), newest first — so each URL
  // appears one-by-one as it is found, straight from the DB (no export needed).
  app.get("/links/validated", async (req) => {
    const q = req.query as { limit?: string; university_id?: string };
    const rows = await linkRepository.listValidated({
      take: q.limit ? Number(q.limit) : 200,
      university_id: q.university_id,
    });
    const items = rows.map((l) => {
      const url = (l.final_url ?? l.url).trim();
      const isCourse = COURSE_URL.test(url.toLowerCase());
      return {
        id: l.id,
        university: l.university?.name ?? "",
        country: l.university?.country ?? "",
        university_id: l.university?.id ?? "",
        level: isCourse ? "course" : "university",
        course_name: isCourse ? deriveCourseName(l.page_title ?? l.link_text, url) : "",
        url,
        http_status: l.http_status ?? null,
        verdict: verdictFor(l.http_status ?? null, l.status),
        evidence: l.evidence ?? "",
        updated_at: l.updated_at,
      };
    });
    return { items, total: items.length };
  });

  // Live re-validation (real network check) — single + batch + progress.
  app.post("/links/:id/revalidate", async (req) => {
    const { id } = req.params as { id: string };
    const r = await revalidateLink(id);
    if (!r) throw new HttpError(404, "Link not found");
    return r;
  });
  app.post("/links/revalidate-all", async () => revalidateAll());
  app.get("/links/revalidate-progress", async () => getRevalidateProgress());

  // Bot-protected / blocked attempts — exact page + university + course tried.
  app.get("/links/blocked", async () => {
    const items = await linkRepository.listBlocked(300);
    return { items, total: items.length };
  });

  app.get("/links", async (req) => {
    const q = listQuery(req);
    return linkRepository.list({
      cursor: q.cursor,
      take: q.take,
      search: q.search,
      university_id: q["university_id"] as string | undefined,
      status: q["status"] as string | undefined,
      minScore: q["minScore"] !== undefined ? Number(q["minScore"]) : undefined,
    });
  });

  app.get("/links/:id", async (req) => {
    const { id } = req.params as { id: string };
    const link = await linkRepository.findById(id);
    if (!link) throw new HttpError(404, "Link not found");
    return link;
  });

  // Re-queue a single link for validation/extraction on the next crawl pass.
  app.post("/links/:id/validate", async (req) => {
    const { id } = req.params as { id: string };
    const link = await linkRepository.findById(id);
    if (!link) throw new HttpError(404, "Link not found");
    await linkRepository.update(id, { status: "QUEUED", retry_count: { increment: 1 } });
    return { id, status: "QUEUED" };
  });

  // Reset broken links (retry_count < 3) back to QUEUED for the retry system.
  app.post("/links/retry-failed", async (req) => {
    const q = req.query as { university_id?: string };
    const failed = await linkRepository.failedRetryable(q.university_id, 500);
    let requeued = 0;
    for (const link of failed) {
      await linkRepository.update(link.id, { status: "QUEUED" });
      requeued += 1;
    }
    return { requeued };
  });
}
