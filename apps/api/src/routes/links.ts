import type { FastifyInstance } from "fastify";
import { rejectScholarship, contextsForTarget } from "@clg/shared";
import { linkRepository } from "@clg/database";
import { listQuery, HttpError } from "../lib/http.js";
import { revalidateLink, revalidateAll, getRevalidateProgress } from "../services/linkValidationService.js";
import { getCrawlSettings } from "../services/crawlAdminService.js";

// A course/programme page lives under the site's course catalog path. Same rule the
// recheck/export step uses to split university-level vs course-level URLs.
const COURSE_URL = /\/(courses?|programmes?|programs?|degrees?)\/[a-z0-9]/i;
// Scholarship / funding pages — surfaced as their own category so the feed doesn't
// lump them under "university" (they export to the separate scholarships file).
const SCHOLARSHIP_URL = /scholarship|bursar|\/funding\b|financial[-_]?aid|\/awards?\b|fellowship|studentship|\/grants?\b/i;

/** Course / scholarship / university, from the URL — the three things we extract. */
function levelOf(url: string): "course" | "scholarship" | "university" {
  const low = url.toLowerCase();
  if (COURSE_URL.test(low)) return "course";
  if (SCHOLARSHIP_URL.test(low)) return "scholarship";
  return "university";
}
const GENERIC_SLUG = /^(courses?|programmes?|programs?|degrees?|study|undergraduate|postgraduate|ug|pg|en|international|admissions?|entry-requirements?|how-to-apply)$/i;

/**
 * Course-variant dedup key: collapses the domestic vs international variant AND
 * year/intake variants of ONE course to a single key — the same collapse the
 * course EXPORT uses — so the live feed shows ONE row per course (not both
 * /courses/x and /international/courses/x). International is preferred as the
 * shipped URL (this is an international-entry deliverable).
 */
function courseDedupKey(url: string): string {
  try {
    const u = new URL(url.toLowerCase());
    u.hash = "";
    u.search = "";
    const path = u.pathname
      .replace(/\/$/, "")
      .replace("/international/courses/", "/courses/")
      .split("/")
      .filter((s) => !/^(19|20)\d\d$/.test(s)) // drop catalog-year segments
      .join("/");
    return `${u.hostname}${path}`;
  } catch {
    return url.toLowerCase();
  }
}

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
    // Scope to the CURRENTLY configured crawl focus (eligibility-only /
    // scholarship-only) so switching focus doesn't leave stale rows from a
    // PAST crawl of the other context in the live feed — that read as "it's
    // crawling everything" even though the current run never touched them.
    // "both" intentionally shows everything (both contexts are active).
    const target = getCrawlSettings().CRAWL_TARGET;
    const rows = await linkRepository.listValidated({
      take: q.limit ? Number(q.limit) : 200,
      university_id: q.university_id,
      crawl_context: target === "both" ? undefined : contextsForTarget(target),
    });
    const items = rows.flatMap((l) => {
      // The feed shows the PRIMARY deliverable URL — the MAIN course page (the
      // same link that lands in the export). The entry-requirements anchor
      // deep-link (eligibility_url) is SECONDARY metadata, exposed separately.
      const url = (l.final_url ?? l.url).trim();
      const level = levelOf(url);
      // Same precision rule as the scholarship EXPORT: blog articles, fee pages,
      // category listings and login pages are never shown as scholarships — the
      // live monitor must match the delivered file.
      if (level === "scholarship" && rejectScholarship(url, "")) return [];
      return {
        id: l.id,
        university: l.university?.name ?? "",
        country: l.university?.country ?? "",
        university_id: l.university?.id ?? "",
        level,
        course_name: level === "course" ? deriveCourseName(l.page_title ?? l.link_text, url) : "",
        url,
        anchor_url: l.eligibility_url ?? null,
        http_status: l.http_status ?? null,
        verdict: verdictFor(l.http_status ?? null, l.status),
        evidence: l.evidence ?? "",
        updated_at: l.updated_at,
      };
    });

    // DEDUP course variants so one course shows ONCE (international preferred) —
    // the same one-per-course result the export delivers. University and
    // scholarship rows pass through untouched.
    const byCourse = new Map<string, (typeof items)[number]>();
    const deduped: typeof items = [];
    for (const it of items) {
      if (it.level !== "course") { deduped.push(it); continue; }
      const key = `${it.university_id}|${courseDedupKey(it.url)}`;
      const prev = byCourse.get(key);
      if (!prev) { byCourse.set(key, it); deduped.push(it); continue; }
      // Keep the international variant if one of the pair is international.
      const prevIntl = /\/international\//i.test(prev.url);
      const curIntl = /\/international\//i.test(it.url);
      if (curIntl && !prevIntl) {
        // `prev`'s POSITION in `deduped` reflects the newest-first order the DB
        // query returned (whichever variant of this course was encountered
        // FIRST while iterating newest-first IS the newer one). Object.assign
        // below upgrades the kept row to the international URL/fields, but
        // used to also overwrite `updated_at` with the OLDER variant's value —
        // so a row sitting near the top (newest position) displayed an OLDER
        // timestamp than rows below it, reading as "out of order" in the feed.
        const newerUpdatedAt = prev.updated_at;
        Object.assign(prev, it);
        if (new Date(newerUpdatedAt).getTime() > new Date(it.updated_at).getTime()) {
          prev.updated_at = newerUpdatedAt;
        }
      }
    }
    // Belt-and-braces: guarantee strict newest-first order after the dedup
    // merge above (which can reorder relative recency between kept rows).
    deduped.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return { items: deduped, total: deduped.length };
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
