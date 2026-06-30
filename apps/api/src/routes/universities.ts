import type { FastifyInstance } from "fastify";
import { universityInputSchema, universityBulkSchema } from "@clg/shared";
import { universityRepository } from "@clg/database";
import { listQuery, HttpError } from "../lib/http.js";
import {
  bulkImportUniversities,
  bulkImportUniversitiesFromBuffer,
  importParsedUniversities,
  startDiscoverMissing,
  getDiscoverProgress,
  discoverOne,
} from "../services/universityService.js";
import { normalizeUrl } from "../services/urlDiscovery.js";
import { startCrawl, startCrawlAll, stopCrawl } from "../services/crawlService.js";
import { verifiedCountsFor, getVerifiedRowsFor } from "../services/crawlAdminService.js";

/**
 * Overlay the VERIFIED deliverable counts (from the validated export files) onto a
 * university row, so the dashboard shows the same numbers that actually ship — not
 * the live DB counters, which only reflect the AI-parsed subset and undercount.
 * `verified_*` is null until the university has been validated & exported; the UI
 * falls back to the live counters in that case.
 */
function withVerifiedCounts<T extends { name: string }>(u: T) {
  const v = verifiedCountsFor(u.name);
  return {
    ...u,
    verified_courses: v ? v.courseUrls : null,
    verified_university_urls: v ? v.universityUrls : null,
    verified_valid_links: v ? v.validUrls : null,
  };
}

export async function universityRoutes(app: FastifyInstance) {
  // Downloadable template (opens in Excel). Only "name" is required — country and
  // website are optional; the website is auto-found when left blank.
  app.get("/universities/template.csv", async (_req, reply) => {
    const csv =
      "name,country,website,notes\r\n" +
      '"Example University","United Kingdom","https://www.example.ac.uk","website optional — auto-found if blank"\r\n' +
      '"Sophia University","Japan","",""\r\n';
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="universities-template.csv"')
      .send(csv);
  });
  // Create one. Website optional → auto-discovered in the background if blank.
  app.post("/universities", async (req, reply) => {
    const parsed = universityInputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid university", parsed.error.issues);
    const created = await universityRepository.create({
      name: parsed.data.name,
      country: parsed.data.country,
      base_url: normalizeUrl(parsed.data.base_url),
      notes: parsed.data.notes ?? null,
    });
    if (!created.base_url) void startDiscoverMissing();
    return reply.code(201).send(created);
  });

  // Auto-find the official website for one / all universities (free, no key).
  app.post("/universities/:id/discover-url", async (req) => {
    const { id } = req.params as { id: string };
    return discoverOne(id);
  });
  app.post("/universities/discover-missing", async () => startDiscoverMissing());
  app.get("/universities/discover-progress", async () => getDiscoverProgress());

  // Bulk import: multipart CSV (field "file"), raw CSV body, or JSON array.
  app.post("/universities/bulk", async (req, reply) => {
    const contentType = req.headers["content-type"] ?? "";

    if (contentType.includes("multipart/form-data")) {
      const file = await (req as unknown as { file: () => Promise<{ toBuffer: () => Promise<Buffer> } | undefined> }).file();
      if (!file) throw new HttpError(400, "No file uploaded");
      const buf = await file.toBuffer();
      // Accepts .xlsx (Excel) or .csv — auto-detected.
      return reply.send(await bulkImportUniversitiesFromBuffer(buf));
    }

    if (contentType.includes("text/csv")) {
      const csv = typeof req.body === "string" ? req.body : "";
      return reply.send(await bulkImportUniversities(csv));
    }

    const parsed = universityBulkSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid bulk payload", parsed.error.issues);
    const res = await importParsedUniversities(
      parsed.data.universities.map((u) => ({
        name: u.name,
        country: u.country,
        base_url: normalizeUrl(u.base_url),
        notes: u.notes ?? null,
      })),
    );
    return reply.send(res);
  });

  // List (cursor pagination + search + status filter). Each row carries the
  // VERIFIED deliverable counts so the table matches the exported files.
  app.get("/universities", async (req) => {
    const q = listQuery(req);
    const page = await universityRepository.list({
      cursor: q.cursor,
      take: q.take,
      search: q.search,
      crawl_status: q["crawl_status"] as string | undefined,
    });
    return { ...page, items: page.items.map(withVerifiedCounts) };
  });

  // Persist the manual drag-to-reorder order (also becomes the crawl order).
  app.put("/universities/reorder", async (req) => {
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) {
      throw new HttpError(400, "Body must be { ids: string[] }");
    }
    return universityRepository.reorder(ids as string[]);
  });

  app.get("/universities/:id", async (req) => {
    const { id } = req.params as { id: string };
    const u = await universityRepository.findById(id);
    if (!u) throw new HttpError(404, "University not found");
    return withVerifiedCounts(u);
  });

  // The exact VERIFIED URLs that shipped for this university (from the validated
  // export files). Drives the per-university "View URLs" drawer.
  app.get("/universities/:id/urls", async (req) => {
    const { id } = req.params as { id: string };
    const u = await universityRepository.findById(id);
    if (!u) throw new HttpError(404, "University not found");
    const rows = getVerifiedRowsFor(u.name);
    const counts = verifiedCountsFor(u.name) ?? { courseUrls: 0, universityUrls: 0, validUrls: 0 };
    return { university: { id: u.id, name: u.name, crawl_status: u.crawl_status }, counts, items: rows };
  });

  // Crawl controls.
  app.post("/universities/:id/crawl", async (req) => {
    const { id } = req.params as { id: string };
    return startCrawl(id);
  });

  app.post("/universities/crawl-all", async () => startCrawlAll());

  // Crawl a chosen SUBSET (checkbox selection on the Universities page). Skips
  // rows with no website; reports how many were queued.
  app.post("/universities/crawl-selected", async (req) => {
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) {
      throw new HttpError(400, "Body must be { ids: string[] }");
    }
    let started = 0;
    let skippedNoUrl = 0;
    const errors: { id: string; message: string }[] = [];
    for (const id of ids as string[]) {
      try {
        await startCrawl(id);
        started += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/no website/i.test(message)) skippedNoUrl += 1;
        else errors.push({ id, message });
      }
    }
    return { started, skippedNoUrl, errors };
  });

  app.post("/universities/:id/stop", async (req) => {
    const { id } = req.params as { id: string };
    return stopCrawl(id);
  });
}
