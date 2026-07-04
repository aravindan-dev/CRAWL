/**
 * ONE-TIME frontier cleanup (safe, reversible: rows are MARKED, never deleted).
 *
 * 1) Collapse year-edition families in the PENDING frontier: for URLs that
 *    differ only by a year path segment (handbook/course/2023..2027/X), keep the
 *    newest edition (or none, if a family member was already visited) and mark
 *    the rest DUPLICATE — they leave the frontier and stop being re-seeded.
 * 2) Alias dedupe of VALIDATED targets: identical content_hash (from the crawl
 *    fingerprints) means the same page under two URLs — keep the earliest
 *    validated row, mark later ones DUPLICATE / content_verified=false.
 * 3) Recompute the university's headline counters.
 *
 * Run: npx tsx src/cleanup-frontier.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prisma, universityRepository } from "@clg/database";
import { repoRoot } from "@clg/shared";
import { createYearEditionGate } from "./discovery/yearEditions.js";

async function main() {
  const unis = await prisma.university.findMany();
  for (const u of unis) {
    console.log(`\n=== ${u.name} (${u.id})`);

    // ---- 1) year-edition collapse of the pending frontier ----
    const visited = await prisma.discoveredLink.findMany({
      where: { university_id: u.id, http_status: { not: null } },
      select: { url: true, final_url: true },
    });
    const pending = await prisma.discoveredLink.findMany({
      where: { university_id: u.id, http_status: null, status: { in: ["QUEUED", "LOW_CONFIDENCE_PAGE"] } },
      select: { id: true, url: true },
    });
    const gate = createYearEditionGate();
    for (const v of visited) {
      gate.seed(v.url);
      if (v.final_url) gate.seed(v.final_url);
    }
    for (const p of pending) gate.observe(p.url);
    const staleIds = pending.filter((p) => gate.shouldSkip(p.url)).map((p) => p.id);
    if (staleIds.length) {
      const res = await prisma.discoveredLink.updateMany({
        where: { id: { in: staleIds } },
        data: {
          status: "DUPLICATE",
          error_message: "older year-edition of a page whose newest edition is crawled instead (frontier collapse)",
        },
      });
      console.log(`  year-edition collapse: ${res.count} pending rows marked DUPLICATE (of ${pending.length} pending)`);
    } else {
      console.log(`  year-edition collapse: nothing to collapse (${pending.length} pending)`);
    }

    // ---- 2) alias dedupe of validated targets via content fingerprints ----
    const fpPath = join(repoRoot(), "storage", "state", "fingerprints", `${u.id}.json`);
    if (existsSync(fpPath)) {
      const fps: Record<string, { content_hash: string }> = JSON.parse(readFileSync(fpPath, "utf8"));
      const validated = await prisma.discoveredLink.findMany({
        where: { university_id: u.id, content_verified: true },
        select: { id: true, canonical_url: true, url: true, created_at: true },
        orderBy: { created_at: "asc" },
      });
      const keeperByHash = new Map<string, string>(); // hash → kept url
      const aliasIds: { id: string; url: string; keeper: string }[] = [];
      for (const v of validated) {
        const fp = v.canonical_url ? fps[v.canonical_url] : undefined;
        if (!fp) continue;
        const keeper = keeperByHash.get(fp.content_hash);
        if (keeper === undefined) keeperByHash.set(fp.content_hash, v.url);
        else aliasIds.push({ id: v.id, url: v.url, keeper });
      }
      for (const a of aliasIds) {
        await prisma.discoveredLink.update({
          where: { id: a.id },
          data: {
            content_verified: false,
            status: "DUPLICATE",
            evidence: `duplicate content of ${a.keeper} (same page under a second URL — one exported)`,
          },
        });
        console.log(`  alias: ${a.url}\n    → duplicate of ${a.keeper}`);
      }
      console.log(`  alias dedupe: ${aliasIds.length} validated alias row(s) marked DUPLICATE`);
    }

    await universityRepository.recomputeStats(u.id);

    const after = await prisma.discoveredLink.count({
      where: { university_id: u.id, http_status: null, status: { in: ["QUEUED", "LOW_CONFIDENCE_PAGE"] } },
    });
    console.log(`  pending frontier after cleanup: ${after}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
