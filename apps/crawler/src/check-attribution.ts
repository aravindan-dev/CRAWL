/**
 * Attribution + correctness check: confirms every eligibility URL is on its OWN
 * university's domain (not misattributed / not drifted off-domain), and reports
 * the university-vs-course split and per-university coverage.
 *
 * Run: tsx src/check-attribution.ts
 */
import { prisma } from "@clg/database";

const ELIG_URL =
  /(admission|entry[-_]?requirement|requirements?|eligib|how[-_]?to[-_]?apply|application|qualif|ucas|prerequisite|entry[-_]?criteria|tariff|\/apply(\/|$)|\/entry(\/|$))/i;
const COURSE_URL =
  /(\/courses?\/|\/programmes?\/|\/programs?\/|\/degrees?\/|\/undergraduate\/[^/]+|\/study\/[^/]+|bachelor|-bsc\b|-bs\b|-ba\b|-beng\b|-bba\b|-llb\b|-msc\b|-ma\b)/i;
const DENY_URL =
  /(imprint|about[-_]?us|newsroom|press|\/research|campus[-_]?map|data[-_]?protection|accessibility|gender[-_]?equality|\/history|\/contact|privacy|sitemap|\/login|\/people\/|\/staff|\/profile\/|\/news\/|\/events?\/|cookie|mailto:|href=)/i;

function host(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
function registrable(h: string): string {
  const p = h.split(".");
  return p.length <= 2 ? h : p.slice(-2).join(".");
}
function sameDomain(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || registrable(a) === registrable(b);
}

async function main() {
  const unis = await prisma.university.findMany({ orderBy: { name: "asc" } });
  let total = 0;
  let onDomain = 0;
  let uniLevel = 0;
  let courseLevel = 0;
  const off: { uni: string; uniHost: string; urlHost: string; url: string }[] = [];
  let withUrls = 0;

  for (const u of unis) {
    const uniHost = host(u.base_url);
    const links = await prisma.discoveredLink.findMany({ where: { university_id: u.id } });
    const seen = new Set<string>();
    let count = 0;
    for (const l of links) {
      const url = (l.final_url ?? l.url).trim();
      const low = url.toLowerCase();
      if (DENY_URL.test(low) || seen.has(low)) continue;
      const isCourse = COURSE_URL.test(low);
      const isElig = ELIG_URL.test(low);
      if (!isCourse && !isElig) continue;
      seen.add(low);
      total++;
      count++;
      if (isCourse) courseLevel++;
      else uniLevel++;
      const urlHost = host(url);
      if (sameDomain(urlHost, uniHost)) onDomain++;
      else off.push({ uni: u.name, uniHost, urlHost, url });
    }
    if (count > 0) withUrls++;
  }

  console.log(`=== ATTRIBUTION ===`);
  console.log(`universities with URLs: ${withUrls}/${unis.length}`);
  console.log(`total eligibility URLs: ${total}  (university=${uniLevel}  course=${courseLevel})`);
  console.log(
    `on correct university domain: ${onDomain}/${total} (${((onDomain / total) * 100).toFixed(2)}%)  off-domain: ${off.length}`,
  );
  if (off.length) {
    console.log(`--- off-domain samples (first 20) ---`);
    for (const o of off.slice(0, 20)) console.log(`OFF  ${o.uni} [${o.uniHost}] -> ${o.urlHost}`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("ATTR_ERROR", e);
  process.exit(1);
});
