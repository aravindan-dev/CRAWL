/**
 * FACTS BACKFILL — extract course facts from the HTML/text artifacts the crawl
 * already saved, WITHOUT re-crawling. Complements the inline extraction in
 * runCrawl: a resumed crawl skips already-visited pages, so facts would otherwise
 * exist only for pages visited after the facts engine shipped. This walks every
 * parseable discovered link that has saved artifacts, runs the same deterministic
 * ladder over them, and merges into storage/state/facts/<universityId>.json
 * (inline crawl-time facts win — they are the freshest).
 *
 * Run: tsx src/backfill-facts.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { prisma } from "@clg/database";
import { repoRoot, canonicalizeUrl, stripTrackingParams } from "@clg/shared";
import { extractCourseFacts, type CourseFacts } from "./extraction/courseFacts.js";

/** Artifact paths in the DB are repo-relative (storage/html/…) — resolve safely. */
function artifact(pathRel: string | null): string | null {
  if (!pathRel) return null;
  const p = resolve(repoRoot(), pathRel);
  return existsSync(p) ? p : null;
}

async function main() {
  const unis = await prisma.university.findMany({ select: { id: true, name: true } });
  let totalPages = 0;
  let totalWithFacts = 0;

  for (const u of unis) {
    const links = await prisma.discoveredLink.findMany({
      where: { university_id: u.id, html_path: { not: null } },
      select: { final_url: true, url: true, html_path: true, text_path: true },
    });
    if (!links.length) continue;

    const factsPath = join(repoRoot(), "storage", "state", "facts", `${u.id}.json`);
    let facts: Record<string, { url: string } & CourseFacts> = {};
    try {
      if (existsSync(factsPath)) facts = JSON.parse(readFileSync(factsPath, "utf8"));
    } catch { /* corrupt = rebuild */ }

    let added = 0;
    for (const l of links) {
      const finalUrl = (l.final_url ?? l.url).trim();
      const key = canonicalizeUrl(finalUrl);
      if (facts[key]) continue; // crawl-time facts win — backfill only fills gaps
      const htmlFile = artifact(l.html_path);
      if (!htmlFile) continue;
      totalPages += 1;
      let html = "";
      let text = "";
      try {
        html = readFileSync(htmlFile, "utf8");
        const textFile = artifact(l.text_path);
        text = textFile ? readFileSync(textFile, "utf8") : html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
      } catch { continue; }
      const f = extractCourseFacts(text, html);
      if (Object.keys(f).length) {
        facts[key] = { url: stripTrackingParams(finalUrl), ...f };
        added += 1;
        totalWithFacts += 1;
      }
    }

    if (added) {
      mkdirSync(dirname(factsPath), { recursive: true });
      writeFileSync(`${factsPath}.tmp`, JSON.stringify(facts), "utf8");
      renameSync(`${factsPath}.tmp`, factsPath);
      console.log(`[backfill-facts] ${u.name}: +${added} pages (total ${Object.keys(facts).length} in state)`);
    }
  }

  console.log(`[backfill-facts] DONE — scanned ${totalPages} artifact pages, extracted facts for ${totalWithFacts}`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("BACKFILL_FACTS_ERROR", e);
  process.exit(1);
});
