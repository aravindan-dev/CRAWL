/**
 * Free, no-key discovery of a university's OFFICIAL website from just its name
 * (+ country). Uses the DuckDuckGo HTML endpoint by default, or a self-hosted
 * SearXNG if SEARX_URL is set. Picks the most "official-looking" result and
 * returns its origin (https://host). Aggregators / social / ranking sites are
 * filtered out so we land on the real institution homepage.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Sites that are never the official university homepage.
const AGGREGATORS =
  /(wikipedia|wikimedia|facebook|fb\.com|linkedin|youtube|youtu\.be|twitter|x\.com|instagram|tiktok|pinterest|timeshighereducation|topuniversities|qs\.com|studyportals|mastersportal|bachelorsportal|shiksha|collegedunia|getmyuni|quora|reddit|britannica|edurank|4icu|unirank|uniranks|webometrics|leverageedu|yocket|idp\.com|study\.com|naukri|indeed|glassdoor|crunchbase|googleusercontent|google\.com|bing\.com|duckduckgo|scholar|researchgate|coursera|edx|udemy|gov\.uk\/|\.gov\/)/i;

/** Make a clean origin (scheme + host) from a URL string, or "" if invalid. */
export function originOf(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** Normalize a user-typed website into a clean URL (adds https:// if missing). */
export function normalizeUrl(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

async function searchWeb(query: string): Promise<string[]> {
  const searx = (process.env.SEARX_URL ?? "").trim().replace(/\/+$/, "");
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 12000);
  try {
    if (searx) {
      const res = await fetch(`${searx}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`, { signal: c.signal, headers: { "user-agent": UA, accept: "application/json" } });
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: { url?: string }[] };
      return Array.from(new Set((data.results ?? []).map((r) => r.url ?? "").filter(Boolean))).slice(0, 12);
    }
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal: c.signal, headers: { "user-agent": UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" } });
    if (!res.ok) return [];
    const html = await res.text();
    const urls = new Set<string>();
    const re = /uddg=([^&"']+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && urls.size < 12) {
      try { const u = decodeURIComponent(m[1]!); if (/^https?:\/\//i.test(u)) urls.add(u); } catch { /* skip */ }
    }
    return Array.from(urls);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** Score a candidate URL on how likely it is the official homepage. */
function officialScore(url: string): number {
  let s = 0;
  const low = url.toLowerCase();
  if (/\.edu(\/|$|\.)/.test(low)) s += 50;
  if (/\.ac\.[a-z]{2}(\/|$)/.test(low)) s += 50; // .ac.uk, .ac.jp …
  if (/\.edu\.[a-z]{2}(\/|$)/.test(low)) s += 45;
  if (/(^|\/\/)[^/]*(uni-|\buniversity\b|\buniv\b|hochschule|universite|universidad|universita)/.test(low)) s += 12;
  try {
    const u = new URL(low);
    // homepage / shallow path is preferred
    if (u.pathname === "/" || u.pathname === "") s += 8;
    if (u.pathname.split("/").filter(Boolean).length <= 1) s += 4;
  } catch { /* ignore */ }
  return s;
}

// Wikimedia asks for a descriptive User-Agent.
const WIKI_UA = "CLGSearch/1.0 (university eligibility URL extractor)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Global throttle so a batch of lookups never bursts Wikidata (which then 429s
// and returns nothing). Serialises calls to >= 350ms apart, retries on 429.
let lastWiki = 0;
async function wikiFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = 600 - (Date.now() - lastWiki);
    if (wait > 0) await sleep(wait);
    lastWiki = Date.now();
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    try {
      const r = await fetch(url, { signal: c.signal, headers: { "user-agent": WIKI_UA, accept: "application/json" } });
      if (r.status === 429 || r.status === 503) { try { await r.body?.cancel(); } catch { /* ignore */ } await sleep(1500 * (attempt + 1)); continue; }
      return r;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}

const INSTITUTION_RE = /(universit|college|institut|polytechnic|hochschule|escuela|école|ecole|académ|academ|higher education|tertiary|business school|school of)/i;

/** Strip parenthetical abbreviations / campus suffixes for a cleaner search label. */
function cleanName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, " ") // (SAIT), (RMIT) …
    .replace(/\b(campus|main campus|city campus)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Generate several search variants so name/abbreviation/typo mismatches still match. */
function nameVariants(name: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => { const v = s.replace(/\s+/g, " ").trim(); if (v) out.add(v); };
  add(name);
  add(cleanName(name));
  // Expand common abbreviations.
  let expanded = name
    .replace(/\bSUNY\b/gi, "State University of New York")
    .replace(/\bCUNY\b/gi, "City University of New York")
    .replace(/\bUni\b/gi, "University")
    .replace(/\bInst\.?\b/gi, "Institute")
    .replace(/\bTech\b/gi, "Technology")
    .replace(/[-–—]/g, " ");
  add(expanded);
  add(cleanName(expanded));
  // A "core" variant without generic suffixes — helps fuzzy search land the entity.
  add(name.replace(/\buniversity of applied sciences\b/gi, "").replace(/\b(university|college|institute|of|the)\b/gi, " ").replace(/\([^)]*\)/g, " "));
  return [...out];
}

interface WdSearch { search?: { id: string }[] }
interface WdEntity { entities?: Record<string, {
  labels?: { en?: { value?: string } };
  aliases?: { en?: { value?: string }[] };
  descriptions?: { en?: { value?: string } };
  claims?: { P856?: { mainsnak?: { datavalue?: { value?: string } } }[] };
}> }
interface WpQuery { query?: { pages?: Record<string, { pageprops?: { wikibase_item?: string } }> } }

// Generic words that don't identify WHICH institution — ignored when matching
// names. NOTE: we deliberately keep "state/new/york" (they distinguish e.g.
// "Buffalo State College" from "University at Buffalo") and drop only the
// abbreviations "suny/cuny" (Wikidata stores the expanded form).
const STOP = new Set([
  "university", "universities", "college", "institute", "institution", "school", "schools",
  "sciences", "science", "applied", "technology", "tech", "polytechnic", "hochschule",
  "fachhochschule", "of", "the", "at", "for", "and", "suny", "cuny",
  "education", "higher", "studies", "academy", "campus",
]);

function distinctive(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length >= 3 && !STOP.has(t)),
  );
}

/**
 * Does a Wikidata entity (label + aliases) genuinely match the input name?
 * Accuracy guard: requires that EVERY meaningful word you typed appears in the
 * matched name (containment). So "Buffalo State College" will NOT match
 * "University at Buffalo" (missing "state"), but "SUNY Oswego" still matches
 * "State University of New York at Oswego" (oswego ⊆ that name).
 */
function nameMatches(input: string, candidates: string[]): boolean {
  const a = distinctive(cleanName(input));
  if (a.size === 0) return false;
  for (const cand of candidates) {
    const b = distinctive(cand);
    if (b.size === 0) continue;
    if (a.size === 1) {
      // A single distinctive word is almost always the place — accept if present
      // (e.g. "SUNY Oswego" → "State University of New York at Oswego").
      const tok = [...a][0];
      if (tok && b.has(tok)) return true;
    } else if (a.size === b.size) {
      // Multi-word names must match EXACTLY (precision) so "Buffalo State College"
      // never matches "University at Buffalo" / its "…at Buffalo" formal alias.
      let eq = true;
      for (const t of a) if (!b.has(t)) { eq = false; break; }
      if (eq) return true;
    }
  }
  return false;
}

/** Candidate Wikidata Q-ids from Wikidata's own entity search. */
async function wikidataQids(q: string): Promise<string[]> {
  const sr = await wikiFetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&format=json&limit=5&type=item`);
  if (!sr || !sr.ok) return [];
  const sj = (await sr.json()) as WdSearch;
  return (sj.search ?? []).map((s) => s.id).filter(Boolean);
}

/**
 * Candidate Q-ids from WIKIPEDIA search — redirect- and typo-aware, so it lands
 * the right article even when the name differs (e.g. "SUNY Plattsburg" →
 * "…Plattsburgh", "Stralsund University of Applied Sciences" → "Hochschule
 * Stralsund") and returns each page's linked Wikidata item.
 */
async function wikipediaQids(q: string): Promise<string[]> {
  const r = await wikiFetch(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=3&prop=pageprops&ppprop=wikibase_item&format=json`);
  if (!r || !r.ok) return [];
  const j = (await r.json()) as WpQuery;
  return Object.values(j.query?.pages ?? {}).map((p) => p.pageprops?.wikibase_item).filter((x): x is string => Boolean(x));
}

/**
 * Given candidate Q-ids, return the official website (P856) of the first entity
 * that is an institution AND whose name genuinely matches the input (accuracy
 * guard — a wrong link is worse than none).
 */
async function siteFromQids(qids: string[], name: string, country: string): Promise<string> {
  let fallback = "";
  for (const id of qids.slice(0, 4)) {
    const dr = await wikiFetch(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`);
    if (!dr || !dr.ok) continue;
    const e = ((await dr.json()) as WdEntity).entities?.[id];
    if (!e) continue;
    const desc = (e.descriptions?.en?.value ?? "").toLowerCase();
    if (!INSTITUTION_RE.test(desc)) continue;
    const site = e.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
    if (!site) continue;
    const origin = originOf(site);
    if (!origin) continue;
    // Accuracy guard: the entity's label/aliases must match the input name.
    const label = e.labels?.en?.value ?? "";
    const aliases = (e.aliases?.en ?? []).map((x) => x.value ?? "");
    if (!nameMatches(name, [label, ...aliases])) continue;
    if (country && desc.includes(country.toLowerCase())) return origin; // best: country matches too
    if (!fallback) fallback = origin;
  }
  return fallback;
}

/**
 * Look up the OFFICIAL WEBSITE (Wikidata property P856) for a university — free
 * and key-less. Tries several name variants against BOTH Wikipedia search
 * (redirect/typo tolerant) and Wikidata search for maximum accuracy.
 */
async function wikidataOfficialSite(name: string, country: string): Promise<string> {
  // Wikipedia search is redirect/typo-tolerant AND more rate-limit friendly, so
  // try it across a few name variants first.
  for (const v of nameVariants(name).slice(0, 3)) {
    const fromWp = await siteFromQids(await wikipediaQids(v), name, country);
    if (fromWp) return fromWp;
  }
  // Wikidata entity-search as a single last resort (it throttles aggressively).
  return siteFromQids(await wikidataQids(name), name, country);
}

/** DuckDuckGo / SearXNG fallback (used only when Wikidata has no match). */
async function searchEngineSite(name: string, country: string): Promise<string> {
  const clean = name.trim();
  const queries = [`${clean} ${country} official website`.trim(), `${clean} university ${country}`.trim()];
  for (const q of queries) {
    const results = (await searchWeb(q)).filter((u) => !AGGREGATORS.test(u));
    if (!results.length) continue;
    const ranked = results
      .map((u) => ({ origin: originOf(u), score: officialScore(u) }))
      .filter((r) => r.origin)
      .sort((a, b) => b.score - a.score);
    if (ranked[0]?.origin) return ranked[0].origin;
  }
  return "";
}

/**
 * Discover the official website for a university name (+ optional country).
 * Wikidata first (reliable, no blocking), then a free search engine as fallback.
 * Returns a clean origin like "https://www.manchester.ac.uk", or "".
 */
export async function discoverUniversityUrl(name: string, country = ""): Promise<string> {
  const clean = name.trim();
  if (!clean) return "";
  return (await wikidataOfficialSite(clean, country)) || (await searchEngineSite(clean, country));
}
