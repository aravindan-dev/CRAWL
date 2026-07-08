import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { PlaywrightCrawler, Configuration, type PlaywrightCrawlingContext } from "crawlee";
import { chromium, type Browser, type BrowserContext } from "playwright";
import {
  env,
  logger,
  hashUrl,
  canonicalizeUrl,
  resolveUrl,
  isSameDomain,
  registrableDomain,
  storagePaths,
  LocalStorageProvider,
  CrawlAction,
  LinkStatus,
  CrawlContext,
  PageClass,
  humanizeError,
  htmlPageFromPdf,
  repoRoot,
  sha256Hex,
  codepointCompare,
  stripTrackingParams,
} from "@clg/shared";
import {
  universityRepository,
  linkRepository,
  snapshotRepository,
  prisma,
  type University,
} from "@clg/database";
import { enqueueParse } from "@clg/queue";
import { filterLink } from "../discovery/linkFilters.js";
import { scoreLink, dispositionFor } from "../discovery/linkScorer.js";
import { shouldFetchForDiscovery } from "../discovery/crawlScope.js";
import { gateUrl, authorizeFetch, CROSS_CONTEXT_FETCH_BLOCKED, type GateResult } from "../discovery/crawlAuthorization.js";
import { classifyUrl } from "../discovery/urlClassifier.js";
import { createThrottle, signalFor } from "../discovery/throttle.js";
import { candidateTargetSources } from "../discovery/targetSources.js";
import { createBranchYield } from "../discovery/branchYield.js";
import { createYearEditionGate } from "../discovery/yearEditions.js";
import { extractLinksFromJson } from "../extraction/finderData.js";
import {
  httpFetchPage,
  extractFromHtml,
  assessFastFetch,
  looksLikeDynamicFinder,
  parseRobotsTxt,
  robotsAllows,
  type RobotsRules,
} from "./httpLane.js";
import { extractPage } from "../extraction/extractPage.js";
import { deepLinkEligibility, entryRequirementAnchor } from "../extraction/eligibilityAnchor.js";
import { captureScreenshot } from "../extraction/screenshot.js";
import { classifyPage, isParseablePage, looksLikeBotChallenge } from "../validation/validatePage.js";
import { validateTarget, TargetOutcome } from "../validation/validateTarget.js";
import { cleanContent } from "../cleaning/contentCleaner.js";
import { chunkSections } from "../chunking/sectionChunker.js";
import { logAction } from "../observability/log.js";

const storage = new LocalStorageProvider();

// INLINE single-pass validation is preserved, but split into its real stages
// (redesign of the validation engine):
//   1. classifyPage      → page HEALTH/shape (validatePage.ts, unchanged idea)
//   2. classifyUrl       → what the FINAL url represents (redirect-safe)
//   3. validateTarget    → context-aware target decision: course IDENTITY first,
//                          then course-level eligibility EVIDENCE (or, in a
//                          scholarship crawl, scholarship identity + evidence),
//                          with explainable reasons. Only VALIDATED_TARGET pages
//                          become exportable results; general admissions/
//                          eligibility pages are DISCOVERY_ONLY.

// Realistic browser headers for sitemap/robots fetches. Many university course
// catalogs (e.g. study.<uni>) sit behind a CDN that answers plain fetches with a
// bot page — but STILL returns the real sitemap XML in the body under a 403.
const SITEMAP_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

/**
 * Fetch a URL's RAW body through a real Chromium page. Course-catalog CDNs
 * (Cloudflare) block Node's fetch by TLS fingerprint — serving a challenge page
 * with no <loc> — but let a real browser through. `response.text()` returns the
 * raw XML (not the rendered DOM), so sitemap parsing works.
 */
async function browserGet(ctx: BrowserContext, url: string, ms: number): Promise<string> {
  let page: Awaited<ReturnType<BrowserContext["newPage"]>> | null = null;
  try {
    page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: ms });
    return resp ? await resp.text() : "";
  } catch {
    return "";
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * HTTP-FIRST fetch (redesign Step 3). A plain `fetch` with a real-browser UA
 * retrieves most sitemaps/robots/redirects in ~100ms and — crucially — WITHOUT
 * launching a headless browser at all. Bot-protected CDNs still fall back to
 * `browserGet`. Returns the raw body (even under a 4xx: some CDNs answer bots
 * with 403 but include the real XML), or "" on network failure/timeout.
 */
async function httpGet(url: string, ms: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { headers: SITEMAP_HEADERS, redirect: "follow", signal: ctrl.signal });
    return await resp.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Same as httpGet but surfaces the status + failure reason, so a caller can
 *  tell "definitely doesn't exist / host unreachable" apart from "network
 *  hiccup, worth a browser retry" without re-fetching. */
async function httpGetEx(url: string, ms: number): Promise<{ body: string; status: number | null; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { headers: SITEMAP_HEADERS, redirect: "follow", signal: ctrl.signal });
    const body = await resp.text();
    return { body, status: resp.status };
  } catch (err: unknown) {
    const e = err as { code?: string; cause?: { code?: string }; name?: string };
    const code = e?.code ?? e?.cause?.code ?? (e?.name === "AbortError" ? "TIMEOUT" : "UNKNOWN");
    return { body: "", status: null, error: code };
  } finally {
    clearTimeout(timer);
  }
}

const looksLikeSitemapXml = (s: string) => /<loc>|<sitemapindex|<urlset/i.test(s);

/**
 * Read sitemap.xml (+ robots.txt sitemaps + nested sitemap indexes) to capture the
 * FULL URL inventory of a site — course-finder results, A-Z lists and programme
 * pages that breadth-first clicking often misses.
 *
 * HTTP-FIRST (Step 3): each sitemap/robots is fetched with a plain `fetch` first;
 * a headless browser is launched LAZILY and only when HTTP returns a bot
 * challenge (no <loc>) — so the common case does zero browser work. Bot-protected
 * course catalogs (e.g. study.<uni>) still fall back to a real browser.
 */
async function discoverSitemapUrls(baseUrl: string, cap = 20000, httpFirst = true): Promise<string[]> {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  // The course CATALOG is very often on a SEPARATE academic subdomain (e.g.
  // study.<uni>, handbook.<uni>, courses.<uni>) — not www. Probe those subdomains'
  // sitemaps too so the full course inventory is captured even when the base URL is
  // www.<uni>. registrableDomain() strips the subdomain to build the siblings.
  const reg = registrableDomain(base.hostname);
  const SUBS = ["", "www.", "study.", "courses.", "handbook.", "programs.", "programmes.", "catalogue.", "catalog.", "future.", "futurestudents."];
  const origins = new Set<string>([base.origin]);
  for (const s of SUBS) origins.add(`https://${s}${reg}`);

  const queue: string[] = [];
  for (const o of origins) queue.push(`${o}/sitemap.xml`, `${o}/sitemap_index.xml`, `${o}/sitemap-index.xml`);

  const out = new Set<string>();
  const seen = new Set<string>();

  // Browser is created ON DEMAND (only when an HTTP fetch looks bot-blocked).
  // Refs held on an object so the lazy assignment inside `ensureBrowser` doesn't
  // confuse control-flow narrowing in the finally cleanup.
  const br: { browser: Browser | null; ctx: BrowserContext | null } = { browser: null, ctx: null };
  const ensureBrowser = async (): Promise<BrowserContext> => {
    if (br.ctx) return br.ctx;
    br.browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--process-per-site"] });
    br.ctx = await br.browser.newContext({ userAgent: SITEMAP_HEADERS["user-agent"] });
    return br.ctx;
  };
  // HTTP-first with browser fallback. `expectXml` guards the fallback: robots.txt
  // is plain text (HTTP always suffices), sitemaps must contain <loc>/<urlset>.
  const fetchBody = async (url: string, ms: number, expectXml: boolean): Promise<string> => {
    if (httpFirst) {
      const res = await httpGetEx(url, ms);
      // A definite 404/410 or an unreachable host means a browser retry would
      // just repeat the same negative result at 10-20x the cost — skip it.
      if (res.status === 404 || res.status === 410) return "";
      if (res.error && ["ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(res.error)) return "";
      if (res.body && (!expectXml || looksLikeSitemapXml(res.body))) return res.body;
    }
    const c = await ensureBrowser();
    return browserGet(c, url, ms);
  };

  try {
    // robots.txt sitemaps for the base + the common course-catalog subdomains.
    for (const o of new Set([base.origin, `https://study.${reg}`, `https://courses.${reg}`, `https://handbook.${reg}`])) {
      const robots = await fetchBody(`${o}/robots.txt`, 8000, false);
      for (const m of robots.matchAll(/sitemap:\s*(\S+)/gi)) queue.push(m[1]!.trim());
    }
    let fetched = 0;
    while (queue.length && fetched < 80 && out.size < cap) {
      const sm = queue.shift()!;
      if (seen.has(sm)) continue;
      seen.add(sm);
      fetched += 1;
      const xml = await fetchBody(sm, 20000, true);
      if (!xml) continue;
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.trim());
      if (/<sitemapindex/i.test(xml)) {
        for (const l of locs) if (!seen.has(l)) queue.push(l); // nested sitemap index
      } else {
        for (const l of locs) {
          out.add(l);
          if (out.size >= cap) break;
        }
      }
    }
    if (br.ctx) await br.ctx.close();
  } catch {
    /* sitemap discovery is best-effort */
  } finally {
    if (br.browser) await br.browser.close().catch(() => {});
  }
  return [...out];
}

/**
 * HTTP-probe likely target-source URLs (Step 4) and return the ones that resolve
 * to a real page (2xx/3xx). Cheap, parallel, short-timeout — no browser. Only the
 * survivors are seeded (still through classify → authorize → filter downstream),
 * so we jump straight to course/scholarship inventories instead of rediscovering
 * them by crawling nav pages.
 */
async function probeTargetSources(baseUrl: string, context: CrawlContext, timeoutMs = 6000): Promise<string[]> {
  const candidates = candidateTargetSources(baseUrl, context);
  const live: string[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (url) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          // GET (not HEAD) — many catalogue routes 405/404 a HEAD but 200 a GET;
          // redirect:follow lets /courses → /courses/ resolve to its final page.
          const resp = await fetch(url, { headers: SITEMAP_HEADERS, redirect: "follow", signal: ctrl.signal });
          return resp.status < 400 ? resp.url || url : null;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    for (const r of results) if (r) live.push(r);
  }
  return [...new Set(live)];
}

interface CrawlUserData {
  depth: number;
  linkScore: number;
  linkText: string;
  /** The crawl context this request belongs to — set at enqueue time, verified
   *  again in the pre-navigation hook (defends against stale/foreign jobs). */
  context: CrawlContext;
  /** Pre-fetch classification the request was authorized under. */
  pageClass: PageClass;
  /** The page this URL was discovered on (classification context clue). */
  parentUrl?: string;
}

export interface CrawlResult {
  linksFound: number;
  validLinks: number;
  snapshots: number;
  pagesVisited: number;
  /** Observability (spec: performance requirement) — proves the isolation. */
  crawlContext: CrawlContext;
  urlsAuthorized: number;
  crossContextRejected: number;
  validatedTargets: number;
  discoveryOnlyPages: number;
  /** Crawlable pages STILL PENDING when this run ended (counted from the DB at
   *  the very end). 0 = the frontier truly drained — only then may the caller
   *  mark anything COMPLETED. >0 = ended early (page budget, stop): the caller
   *  must record STOPPED so a resume continues instead of skipping the rest. */
  pendingRemaining: number;
  /** True when the run ended because MAX_PAGES_PER_UNIVERSITY was reached. */
  stoppedAtBudget: boolean;
}

/**
 * Crawl one university end-to-end UNDER ONE CRAWL CONTEXT (eligibility XOR
 * scholarship): discover → classify → authorize → score → fetch → validate →
 * extract → clean → chunk → enqueue parse. Cross-context URLs are rejected
 * BEFORE any network request. Uses an isolated in-memory Crawlee Configuration
 * per job so concurrent university crawls don't share storage.
 */
export async function runUniversityCrawl(
  university: University,
  crawlJobId: string,
  context: CrawlContext = CrawlContext.ELIGIBILITY,
): Promise<CrawlResult> {
  const result: CrawlResult = {
    linksFound: 0,
    validLinks: 0,
    snapshots: 0,
    pagesVisited: 0,
    crawlContext: context,
    urlsAuthorized: 0,
    crossContextRejected: 0,
    validatedTargets: 0,
    discoveryOnlyPages: 0,
    pendingRemaining: 0,
    stoppedAtBudget: false,
  };
  const seenHashes = new Set<string>();

  // PERF INSTRUMENTATION (redesign Step 1 — "measure the bottleneck first").
  // Cumulative wall-time per hot-path stage + operation counts, summarized once
  // at the end of THIS crawl. runUniversityCrawl is invoked once per context, so
  // the summary is naturally per-context (separate eligibility / scholarship
  // reports). Durations are CUMULATIVE handler time; with a single-domain crawl
  // the same-domain delay serializes requests so concurrency≈1 and these sum to
  // roughly wall-clock — but per-page averages are reported too as they're robust
  // regardless of concurrency. Pure Date.now() diffs → no measurable overhead.
  const crawlStartedAt = Date.now();
  const ms = { settle: 0, finder: 0, extract: 0, screenshot: 0, validate: 0, cleanChunk: 0, dbWrite: 0, sitemap: 0 };
  const n = { pwNav: 0, dead: 0, finder: 0, screenshot: 0, dup: 0, httpFetch: 0 };
  // Why each escalated page needed the browser (PERF observability).
  const esc = { network: 0, challenge: 0, blocked: 0, thin: 0, finder: 0, validated: 0 };
  const timeMs = async <T>(bucket: keyof typeof ms, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      ms[bucket] += Date.now() - t;
    }
  };

  // ADAPTIVE THROTTLE (Step 2): drives the inter-request delay from live server
  // health instead of a fixed CRAWL_DELAY_MS sleep after every request. Healthy →
  // 0 delay; 429/5xx → back off + shrink concurrency. When disabled, the crawler
  // keeps the old fixed sameDomainDelay (see config below) and this is never read.
  const adaptive = env.CRAWL_ADAPTIVE_THROTTLE;
  const throttle = createThrottle({
    baseDelayMs: env.CRAWL_DELAY_MS,
    maxDelayMs: 8000,
    maxConcurrency: env.PER_DOMAIN_CONCURRENCY,
    minConcurrency: 1,
    minDelayMs: env.CRAWL_MIN_DELAY_MS, // politeness floor — never burst at 0ms
  });

  // BRANCH-YIELD PRUNING (Step 7): stops expanding LOW-tier discover-only links
  // from URL branches proven barren (many visits, zero validated targets). Never
  // affects course/eligibility/scholarship candidate links or catalogue seeds.
  const branchYield = createBranchYield({ minPages: env.PRUNE_BRANCH_MIN_PAGES });
  let branchesPruned = 0;
  // CATALOG-DRIVEN SCOPE (crawlScope.ts): generic low-value links skipped because
  // they are neither a target candidate, a target listing, nor a course hub.
  let scopeSkipped = 0;

  // YEAR-EDITION COLLAPSE (Step 7): year-versioned catalogue/handbook URLs
  // (/course/2023/X … /course/2027/X) are editions of the SAME page — crawl only
  // the newest edition per family. Gated by the same PRUNE_DEAD_BRANCHES flag
  // (both are "stop low-value crawling"). Seeded below with already-visited URLs
  // so a resume never re-crawls older siblings of pages done last run.
  const yearGate = createYearEditionGate();
  let yearEditionsSkipped = 0;
  const skipOldEdition = (url: string): boolean => {
    if (!env.PRUNE_DEAD_BRANCHES) return false;
    if (!yearGate.shouldSkip(url)) return false;
    yearEditionsSkipped += 1;
    return true;
  };

  // CONTENT FINGERPRINTS (redesign §8.1): per-page hashes over NORMALIZED content
  // so the diff engine can classify UNCHANGED/UPDATED/MOVED without re-parsing —
  // and so cosmetic churn (scripts/CSS/whitespace) is invisible by construction.
  // Persisted per university; merged on resume; written atomically.
  const fpPath = join(repoRoot(), "storage", "state", "fingerprints", `${university.id}.json`);
  let fingerprints: Record<string, { url: string; content_hash: string; meta_hash: string; links_hash: string; updated_utc: string }> = {};
  try {
    if (existsSync(fpPath)) fingerprints = JSON.parse(readFileSync(fpPath, "utf8"));
  } catch { /* corrupt fingerprint state = start fresh */ }
  // MERGE-ON-WRITE: another writer (facts backfill, a parallel tool) may update
  // the same state file while the crawl runs — re-read + merge before writing so
  // whole-file writes never clobber each other's entries (crawl-time wins per key).
  const flushFingerprints = () => {
    try {
      mkdirSync(dirname(fpPath), { recursive: true });
      let onDisk: typeof fingerprints = {};
      try { if (existsSync(fpPath)) onDisk = JSON.parse(readFileSync(fpPath, "utf8")); } catch { /* ignore */ }
      const merged = { ...onDisk, ...fingerprints };
      writeFileSync(`${fpPath}.tmp`, JSON.stringify(merged), "utf8");
      renameSync(`${fpPath}.tmp`, fpPath);
    } catch { /* fingerprints are advisory — never fail the crawl */ }
  };

  // LIVE counters: RECOMPUTE the headline counters from the real tables so the
  // dashboard's Links / Valid / Courses are always authoritative and can never
  // drift (the old per-event increments double-counted across resumes, giving
  // nonsense like valid > links). Recompute is debounced (not per page) so it
  // stays cheap while still ticking up live during the crawl.
  let pagesSinceRecount = 0;
  const flushCounters = async () => {
    pagesSinceRecount = 0;
    flushFingerprints(); // piggyback: fingerprints persist on the same debounce
    await universityRepository.recomputeStats(university.id).catch(() => {});
  };
  // CHEAP live-stat refresh: recomputeStats is an indexed DB count (fast at any
  // scale). Unlike flushCounters, this never touches disk — safe to call on
  // EVERY valid page. flushFingerprints/flushFacts read-merge-rewrite the
  // ENTIRE per-university JSON file; calling that per valid page (as opposed to
  // the debounced call sites below) turned into O(n^2) synchronous I/O that
  // blocked the event loop once a university had hundreds of valid pages —
  // observed as the crawl visibly slowing down after ~600 validated links.
  const bumpLiveStats = async () => {
    await universityRepository.recomputeStats(university.id).catch(() => {});
  };

  // FINALIZE a validated COURSE target: clean → chunk → persist the CLEANED
  // sections (what the course-criteria parser reads) → snapshot → enqueue parse.
  // Shared by both lanes so a validated page is recorded identically whether it
  // was served by the fast HTTP lane or the browser lane. Raw HTML + screenshots
  // are passed through (null when their env flags are off) — the parser never
  // needs them, so with screenshots off a validated target is fully finalised
  // here in the fast lane (no browser round-trip, no separate phase to fail).
  const finalizeCourseTarget = async (opts: {
    linkId: string;
    requestUrl: string;
    finalUrl: string;
    urlHash: string;
    extracted: Parameters<typeof cleanContent>[0];
    sourceLanguage: string | null;
    htmlPath: string | null;
    screenshotPath: string | null;
  }): Promise<number> => {
    const cleaned = cleanContent(opts.extracted);
    const sections = chunkSections(cleaned.blocks, {
      source_url: opts.finalUrl,
      page_title: opts.extracted.page_title,
      university_id: university.id,
    });
    const cleanedTextPath = await storage.saveText(`storage/text/${university.id}/${opts.urlHash}.cleaned.txt`, cleaned.cleaned_text);
    await storage.saveJson(`storage/text/${university.id}/${opts.urlHash}.sections.json`, {
      cleaned_text: cleaned.cleaned_text,
      tables: cleaned.tables,
      sections,
    });
    const snapshot = await snapshotRepository.create({
      university_id: university.id,
      discovered_link_id: opts.linkId,
      crawl_context: context,
      url: opts.requestUrl,
      final_url: opts.finalUrl,
      page_title: opts.extracted.page_title,
      source_language: opts.sourceLanguage,
      raw_html_path: opts.htmlPath,
      cleaned_text_path: cleanedTextPath,
      screenshot_path: opts.screenshotPath,
      extracted_text: cleaned.cleaned_text.slice(0, 200000),
    });
    result.snapshots += 1;
    result.validLinks += 1;
    await bumpLiveStats(); // reflect each valid page live — cheap (DB count only)
    await enqueueParse({ universityId: university.id, snapshotId: snapshot.id, crawlJobId, context });
    return sections.length;
  };

  // SOFT time target (never a cap): the crawl ALWAYS runs to completion — every
  // discovered page is crawled, no data is ever dropped for time. MAX_CRAWL_MINUTES
  // is only the performance target we aim to finish under (per-page costs below are
  // tuned for it); exceeding it logs a notice and the crawl simply continues. This
  // is what makes repeated crawls of an unchanged site deterministic: coverage can
  // never depend on how fast the network happened to be that day.
  const softTargetAt = env.MAX_CRAWL_MINUTES > 0 ? Date.now() + env.MAX_CRAWL_MINUTES * 60_000 : Infinity;
  let targetNoticeLogged = false;

  // RESUME: pages already visited in a previous (stopped/crashed) run are skipped,
  // and the still-pending frontier is re-seeded — so a crawl continues exactly
  // where it left off instead of starting over. DB-driven → survives restarts.
  // Context-scoped: only THIS context's visits/frontier count (the other
  // context's progress must never be mistaken for ours).
  // COVERAGE RECOVERY (100%-coverage guarantee): pages refused during a
  // bot-protection episode are NOT gone forever. A CDN flag decays after some
  // hours — so before resuming, probe each BLOCKED host once (cheap HTTP GET);
  // if it answers cleanly again, re-queue everything that was refused there
  // (including challenge pages that were "visited": their http_status is reset
  // so the resume treats them as pending). A still-flagged host stays BLOCKED
  // and is re-probed on the next crawl — no coverage is ever silently dropped.
  try {
    const blockedRows = await prisma.discoveredLink.findMany({
      where: { university_id: university.id, crawl_context: context, status: "BLOCKED" },
      select: { id: true, url: true },
    });
    if (blockedRows.length) {
      const byHost = new Map<string, string[]>();
      for (const r of blockedRows) {
        try {
          const h = new URL(r.url).hostname;
          if (!byHost.has(h)) byHost.set(h, []);
          byHost.get(h)!.push(r.id);
        } catch { /* malformed url — leave blocked */ }
      }
      const recoveredIds: string[] = [];
      const recoveredHosts: string[] = [];
      // Probe an ACTUAL blocked page per host, not robots.txt: some sites (e.g.
      // study.csu.edu.au) 403 robots.txt by policy while serving real content
      // fine, so a robots probe permanently reads as "still blocked" and the
      // pages never recover. A real page GET returning 2xx/3xx + no challenge
      // markers is the trustworthy "host is back" signal.
      const sampleUrlByHost = new Map<string, string>();
      for (const r of blockedRows) {
        try { const h = new URL(r.url).hostname; if (!sampleUrlByHost.has(h)) sampleUrlByHost.set(h, r.url); } catch { /* skip */ }
      }
      for (const [host, ids] of byHost) {
        const sample = sampleUrlByHost.get(host);
        if (!sample) continue;
        const res = await httpFetchPage(sample, SITEMAP_HEADERS, 10000);
        const okStatus = (res.status ?? 0) >= 200 && (res.status ?? 0) < 400;
        if (res.ok && okStatus && !looksLikeBotChallenge(res.body.slice(0, 8000))) {
          recoveredIds.push(...ids);
          recoveredHosts.push(`${host} (${ids.length})`);
        }
      }
      if (recoveredIds.length) {
        await prisma.discoveredLink.updateMany({
          where: { id: { in: recoveredIds } },
          data: { status: "QUEUED", http_status: null, content_verified: false, error_message: null },
        });
        await logAction({
          university_id: university.id,
          action: CrawlAction.DISCOVER_LINKS,
          status: "OK",
          message: `coverage recovery: ${recoveredIds.length} previously blocked URL(s) re-queued — host(s) recovered from bot-protection: ${recoveredHosts.join(", ")}`,
        }).catch(() => {});
      }
    }
  } catch { /* recovery is best-effort — the crawl proceeds either way */ }

  const { done: doneUrls, pending: pendingFrontier } = await linkRepository.resumeState(university.id, context);
  const isResume = doneUrls.size > 0;
  const isDone = (u: string) => doneUrls.has(u) || doneUrls.has(canonicalizeUrl(u));
  // Year-edition families already crawled in a prior run: record them so older
  // sibling editions in the pending frontier are skipped on this resume.
  for (const u of doneUrls) yearGate.seed(u);

  // CONTENT-HASH ALIAS DEDUPE: some sites serve the SAME page under multiple
  // slugs (observed: /master-paramedicine ≡ /master-critical-care-paramedicine,
  // identical content hash). Only ONE of an identical-content family may be a
  // validated target — later aliases are recorded but marked duplicate (not
  // exported, no snapshot). Pre-load hashes of pages validated in prior runs
  // (via the persisted fingerprints) so resumes can't re-admit an alias.
  const validatedContentHashes = new Map<string, string>(); // content_hash → canonical url
  try {
    const prior = await prisma.discoveredLink.findMany({
      where: { university_id: university.id, crawl_context: context, content_verified: true },
      select: { canonical_url: true },
    });
    for (const r of prior) {
      const fp = r.canonical_url ? fingerprints[r.canonical_url] : undefined;
      if (fp && r.canonical_url) validatedContentHashes.set(fp.content_hash, r.canonical_url);
    }
  } catch { /* preload is best-effort — in-run dedupe still applies */ }

  // Per-job isolated config (no on-disk request queue shared across crawls).
  const config = new Configuration({ persistStorage: false });

  const recordDiscovery = async (
    url: string,
    linkText: string,
    score: number,
    depth: number,
    status: LinkStatus,
    pageClass?: PageClass,
  ) => {
    const canonical = canonicalizeUrl(url);
    const urlHash = hashUrl(url);
    if (seenHashes.has(urlHash)) return;
    seenHashes.add(urlHash);
    await linkRepository.upsert({
      university_id: university.id,
      url,
      canonical_url: canonical,
      url_hash: urlHash,
      link_text: linkText,
      link_score: score,
      depth,
      status,
      crawl_context: context,
      page_class: pageClass ?? null,
    });
    result.linksFound += 1;
  };

  // Record a URL that was discovered + classified, then REFUSED before fetch
  // because it belongs to the other crawl context. The row is the audit trail
  // (status, class, why); the URL never reaches the request queue or network.
  const rejectCrossContext = (
    rows: Parameters<typeof linkRepository.createManyDiscovered>[0],
    url: string,
    text: string,
    depth: number,
    gate: GateResult,
  ) => {
    rows.push({
      university_id: university.id,
      url,
      url_hash: hashUrl(url),
      canonical_url: canonicalizeUrl(url),
      link_text: text,
      link_score: 0,
      depth,
      status: LinkStatus.REJECTED_CROSS_CONTEXT,
      crawl_context: context,
      page_class: gate.classification.pageClass,
      error_message: gate.decision.reason,
    });
    result.crossContextRejected += 1;
  };

  const crawler = new PlaywrightCrawler(
    {
      maxConcurrency: env.PER_DOMAIN_CONCURRENCY,
      maxRequestsPerCrawl: env.MAX_PAGES_PER_UNIVERSITY,
      // Reasonable per-page budgets: with a real browser UA, live pages respond in
      // ~1–3s — 20s is generous, and dead/slow pages fail fast instead of burning
      // 30s each. Bounded, FIXED retry count (3 attempts total) keeps failure cost
      // deterministic: a dead URL costs at most ~60s, not minutes.
      navigationTimeoutSecs: 20,
      requestHandlerTimeoutSecs: 90,
      maxRequestRetries: 2,
      // Ethical crawling (Section 19): obey robots.txt. The politeness DELAY is
      // now adaptive (Step 2) — 0 while the server is healthy, and applied in the
      // pre-navigation hook only when the throttle has backed off (429/5xx). With
      // adaptive throttle disabled we keep the old fixed fractional-second delay.
      respectRobotsTxtFile: true,
      sameDomainDelaySecs: adaptive ? 0 : env.CRAWL_DELAY_MS / 1000,
      // SKIPPED ≠ PENDING: a request Crawlee skips (robots.txt disallow, limits)
      // never reaches the requestHandler, so without this its row stays QUEUED
      // forever — every resume re-seeds it, it gets skipped again, and the crawl
      // "finishes" with a large frontier still pending (observed live: a flagged
      // CDN answering robots.txt with a challenge made Crawlee skip whole hosts).
      // Mark such rows BLOCKED so they leave the frontier with an honest reason.
      onSkippedRequest: async ({ url, reason }) => {
        try {
          const row = await linkRepository.upsert({
            university_id: university.id,
            url,
            url_hash: hashUrl(url),
            status: LinkStatus.BLOCKED,
            crawl_context: context,
          });
          await linkRepository.update(row.id, {
            status: LinkStatus.BLOCKED,
            error_message: `skipped before fetch: ${reason}${reason === "robotsTxt" ? " (robots.txt fetch denied/disallowed — possibly a bot-protection challenge)" : ""}`,
          });
        } catch { /* audit trail is best-effort — never fail the crawl */ }
      },
      // Browser lifetime: retire + relaunch periodically so slow Chromium leaks
      // can't accumulate into the 0xC0000409 hard crash. Was 15 when EVERY page
      // rode the browser; with the fast lane the browser sees only escalations
      // (~10-15% of pages, images/media blocked), so memory grows far slower —
      // 40 halves the relaunch tax AND keeps the cf_clearance cookie alive
      // longer between retirements (each relaunch re-faces bot protection).
      browserPoolOptions: { retireBrowserAfterPageCount: 40 },
      launchContext: {
        launchOptions: {
          args: [
            "--no-sandbox",
            "--disable-dev-shm-usage", // don't use limited /dev/shm for shared memory
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-renderer-backgrounding",
            // One renderer process per SITE instead of per tab: our concurrent
            // tabs are all on the same university's domain, so they share a
            // single renderer — the "1 Chromium + shared contexts" RAM profile
            // without giving up per-crawl crash isolation. Safe for a crawler
            // (site-isolation is a browsing-security feature, not a crawl need).
            "--process-per-site",
          ],
        },
      },
      preNavigationHooks: [
        // DEFENSIVE CRAWL AUTHORIZATION — the last gate BEFORE the network.
        // Every request was already classified + authorized at enqueue time, but
        // stale/recovered queue entries, foreign producers or future regressions
        // must not slip through: re-verify the request's context and re-classify
        // its URL here, and abort (no retry, no navigation) on any violation.
        async ({ request }) => {
          const ud = (request.userData ?? {}) as Partial<CrawlUserData>;
          if (ud.context && ud.context !== context) {
            request.noRetry = true;
            throw new Error(`${CROSS_CONTEXT_FETCH_BLOCKED}: request context ${ud.context} does not match crawl context ${context}`);
          }
          if ((ud.depth ?? 0) > 0) {
            // Child links must re-pass authorization (the seed/base URL is the
            // user-provided crawl root and is always fetchable).
            const check = authorizeFetch(
              ud.pageClass ?? classifyUrl({ url: request.url, anchorText: ud.linkText }).pageClass,
              context,
            );
            if (!check.allowed && check.crossContext) {
              request.noRetry = true;
              throw new Error(`${CROSS_CONTEXT_FETCH_BLOCKED}: ${check.reason}`);
            }
          }
          // ADAPTIVE POLITENESS DELAY (Step 2): applied AFTER authorization so a
          // to-be-rejected request never waits. 0 while the server is healthy;
          // grows only after the throttle observes 429/5xx push-back.
          if (adaptive && throttle.delayMs > 0) {
            await new Promise((r) => setTimeout(r, throttle.delayMs));
          }
        },
        async ({ page }, gotoOptions) => {
          // Resolve on DOM ready (heavy sites never fire "load" in time).
          if (gotoOptions) gotoOptions.waitUntil = "domcontentloaded";
          await page.setExtraHTTPHeaders({ "User-Agent": env.USER_AGENT });
          // Desktop viewport so the proof screenshot renders the real desktop layout.
          await page.setViewportSize({ width: 1366, height: 900 }).catch(() => {});
          // SPEED + READABLE SCREENSHOTS: KEEP stylesheets + fonts so each page
          // renders with its real layout (the proof screenshot must look like the
          // actual site, not an unstyled mess). Still block the heavy stuff that
          // doesn't affect links or readability — images, media, and analytics /
          // tracker scripts — so the crawl stays fast and light.
          await page.route("**/*", (route) => {
            const t = route.request().resourceType();
            if (t === "image" || t === "media") return route.abort();
            const u = route.request().url();
            if (/googletagmanager|google-analytics|doubleclick|facebook\.net|hotjar|cookiebot|onetrust|segment\.com|optimizely/i.test(u)) return route.abort();
            return route.continue();
          }).catch(() => {});
          // tsx/esbuild `keepNames` injects __name(...) wrappers into page.evaluate
          // functions; that helper doesn't exist in the browser. Shim it.
          await page.addInitScript(() => {
            const w = window as unknown as { __name?: (fn: unknown) => unknown };
            if (!w.__name) w.__name = (fn) => fn;
          });
        },
      ],
      async requestHandler(ctx: PlaywrightCrawlingContext) {
        const { request, page, response } = ctx;
        const userData = (request.userData ?? {}) as Partial<CrawlUserData>;
        const depth = userData.depth ?? 0;

        // SOFT TIME TARGET: passing it never stops the crawl — completeness beats
        // the clock. Log once so the dashboard shows why a huge site runs long.
        if (Date.now() > softTargetAt && !targetNoticeLogged) {
          targetNoticeLogged = true;
          await logAction({ university_id: university.id, action: CrawlAction.DISCOVER_LINKS, status: "OK", message: `Target crawl time (${env.MAX_CRAWL_MINUTES} min) exceeded — continuing until every discovered page is crawled (no data is dropped).` }).catch(() => {});
        }

        // RESUME: this page was already crawled in a previous run — skip the
        // expensive re-extraction so we continue where we left off.
        if (isResume && isDone(request.url)) return;
        result.pagesVisited += 1;
        n.pwNav += 1; // one full Playwright navigation actually did work

        // FAST settle: wait until the DOM is QUIET (no mutations for 250ms) instead
        // of a fixed sleep — static pages proceed in ~250ms (was a flat 600ms on
        // every page, pure dead time at scale), while JS-driven pages get up to
        // 1.5s to finish rendering their links. Deterministic: the wait ends on a
        // provable condition (DOM stability), not on a guess.
        const settleT = Date.now();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page
          .evaluate(
            () =>
              new Promise<void>((resolve) => {
                const finish = () => {
                  obs.disconnect();
                  resolve();
                };
                let quiet = setTimeout(finish, 250);
                const obs = new MutationObserver(() => {
                  clearTimeout(quiet);
                  quiet = setTimeout(finish, 250);
                });
                obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
                setTimeout(finish, 1500); // hard cap so a busy page can't stall the crawl
              }),
          )
          .catch(() => {});
        ms.settle += Date.now() - settleT;

        // CLOUDFLARE CHALLENGE ESCAPE (Section 22): the initial DOM settle above
        // landed on the Cloudflare challenge interstitial ("Just a moment..."). The
        // challenge JS runs a proof-of-work and then reloads the page with real
        // content. Detect the challenge state and wait for that reload before
        // proceeding to extraction.
        const wasChallenged = await page
          .evaluate(() => {
            const t = document.title;
            const b = (document.body?.innerText ?? "").slice(0, 200);
            return /just a moment/i.test(t) || /checking your browser/i.test(t) || /verify(ing)? you are (a )?human/i.test(b);
          })
          .catch(() => false);
        if (wasChallenged) {
          try {
            await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 });
            // Re-settle on the now-real page content.
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            await page
              .evaluate(
                () =>
                  new Promise<void>((resolve) => {
                    const finish = () => {
                      obs.disconnect();
                      resolve();
                    };
                    let quiet = setTimeout(finish, 250);
                    const obs = new MutationObserver(() => {
                      clearTimeout(quiet);
                      quiet = setTimeout(finish, 250);
                    });
                    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
                    setTimeout(finish, 1500);
                  }),
              )
              .catch(() => {});
          } catch {
            /* navigation didn't happen within 15s — challenge may not be solvable; extraction proceeds on current content */
          }
        }

        // Target links harvested from a finder's embedded JSON (Step 5); folded
        // into discovery below so they pass the same classify→authorize gate.
        const finderJsonUrls: string[] = [];

        // FINDER EXPANSION IS FOR LISTINGS ONLY. The DOM heuristic below
        // (tables / "view all" text) fires on ordinary course pages too — a fees
        // or entry-requirements <table> is not a course finder — and the
        // expansion (networkidle waits + click/scroll loops) costs ~5–10s per
        // page. On a catalogue site where nearly every page is a course page,
        // that alone caps the crawl at ~7 pages/min. Individual target pages
        // (course/scholarship/eligibility/admissions) skip expansion entirely;
        // listings, finders, navigation and unknown pages keep it.
        const preClass =
          userData.pageClass ?? classifyUrl({ url: request.url, anchorText: userData.linkText }).pageClass;
        const mayExpandFinder =
          preClass !== PageClass.COURSE_PAGE &&
          preClass !== PageClass.SCHOLARSHIP_PAGE &&
          preClass !== PageClass.ELIGIBILITY_PAGE &&
          preClass !== PageClass.ADMISSIONS_PAGE &&
          preClass !== PageClass.INTERNATIONAL_ADMISSIONS_PAGE;

        // Does this page have a DYNAMIC course/program list worth extra effort?
        // Note: a bare `table tbody tr` is NOT a finder signal — every static
        // fees/requirements/handbook table matched it, sending thousands of
        // ordinary pages through the expansion. Only genuine dynamic-list
        // markers count: DataTables length selectors, finder/datatable class
        // names, or load-more/show-more affordances in the page text.
        const isFinder = mayExpandFinder && (await page
          .evaluate(() => {
            if (document.querySelector('select[name$="_length"], .dataTables_length, [class*="datatable" i], [class*="finder" i]')) return true;
            return /load more|show more|view all|see all|more courses|load all/i.test((document.body && document.body.innerText) || "");
          })
          .catch(() => false));

        if (isFinder) {
          n.finder += 1;
          const finderT = Date.now();
          // JSON-FIRST (Step 5): most finders ship their whole result set in
          // __NEXT_DATA__ / a JSON island. Pull those target links straight from
          // the HTML we already have — no clicking/scrolling. Only fall back to
          // expensive browser expansion when the JSON path is thin, so browser
          // work is the exception, not the rule.
          const finderHtml = await page.content().catch(() => "");
          for (const u of extractLinksFromJson(finderHtml, page.url())) finderJsonUrls.push(u);
          const jsonSufficient = finderJsonUrls.length >= 15;
          if (!jsonSufficient) {
          // Let the AJAX rows arrive, then reveal/expand them.
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
          // Reveal lazy-loaded cards: click "Load more / Show more / View all"
          // and infinite-scroll until nothing new appears.
          const moreRe = /load more|show more|view all|view more|see all|more results|more courses|load all/i;
          for (let i = 0; i < 6; i++) {
            const more = page.getByRole("button", { name: moreRe }).or(page.getByRole("link", { name: moreRe })).first();
            if (await more.isVisible().catch(() => false)) {
              await more.click({ timeout: 2500 }).catch(() => {});
              await page.waitForTimeout(900);
              await page.evaluate("window.scrollTo(0, document.body.scrollHeight)").catch(() => {});
              continue;
            }
            const before = (await page.evaluate("document.body.scrollHeight").catch(() => 0)) as number;
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)").catch(() => {});
            await page.waitForTimeout(600);
            const after = (await page.evaluate("document.body.scrollHeight").catch(() => 0)) as number;
            if (after <= before) break;
          }
          // DataTables: force the "show N entries" selector to its largest / "All"
          // option so EVERY row's program link renders at once (e.g. Seneca PGWP).
          await page.evaluate(() => {
            const sels = document.querySelectorAll(
              'select[name$="_length"], .dataTables_length select, select[aria-label*="entries" i], select[aria-label*="show" i]',
            );
            for (const node of Array.from(sels)) {
              const s = node as HTMLSelectElement;
              let bestVal = -Infinity;
              let best: HTMLOptionElement | null = null;
              for (const o of Array.from(s.options)) {
                const v = o.value === "-1" || /all/i.test(o.textContent ?? "") ? Number.MAX_SAFE_INTEGER : Number(o.value) || 0;
                if (v > bestVal) { bestVal = v; best = o; }
              }
              if (best && s.value !== best.value) { s.value = best.value; s.dispatchEvent(new Event("change", { bubbles: true })); }
            }
          }).catch(() => {});
          await page.waitForTimeout(700);
          await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
          // RENDER FIXED-POINT (redesign §3.4): a finder page is only "done" when
          // two consecutive extractions see the SAME link count — lazy rows can't
          // make the discovered set depend on timing. Max 3 checks, 400ms apart.
          let prevLinkCount = -1;
          for (let i = 0; i < 3; i++) {
            const count = (await page.evaluate(() => document.querySelectorAll("a[href]").length).catch(() => 0)) as number;
            if (count === prevLinkCount) break;
            prevLinkCount = count;
            await page.waitForTimeout(400);
          }
          } // end !jsonSufficient browser-expansion fallback
          ms.finder += Date.now() - finderT;
        }

        const httpStatus = response?.status() ?? null;
        // ADAPTIVE THROTTLE feedback (Step 2): let the server's health steer the
        // next delay + concurrency. Pushing concurrency into the live autoscaled
        // pool is best-effort (guarded) — a Crawlee internals change must never
        // crash the crawl.
        if (adaptive) {
          const { concurrency } = throttle.note(signalFor(httpStatus));
          try {
            const pool = ctx.crawler.autoscaledPool;
            if (pool && pool.desiredConcurrency !== concurrency) pool.desiredConcurrency = concurrency;
          } catch { /* ignore — throttle delay still applies */ }
        }
        const extracted = await timeMs("extract", () => extractPage(page, request.url));
        const finalUrl = extracted.final_url;
        const urlHash = hashUrl(finalUrl);

        // REDIRECT SAFETY: a URL authorized on its ORIGINAL path may have
        // redirected into the other context. Re-classify the FINAL url and stop
        // here on a violation: no artifacts, no validation, no snapshot, no
        // link discovery — the page is recorded as cross-context and discarded.
        const finalClass = classifyUrl({ url: finalUrl, anchorText: userData.linkText });
        const redirectCheck = authorizeFetch(finalClass.pageClass, context);
        if (!redirectCheck.allowed && redirectCheck.crossContext) {
          const rejected = await linkRepository.upsert({
            university_id: university.id,
            url: request.url,
            canonical_url: canonicalizeUrl(finalUrl),
            url_hash: urlHash,
            link_text: userData.linkText ?? extracted.page_title,
            depth,
            status: LinkStatus.REJECTED_CROSS_CONTEXT,
            crawl_context: context,
            page_class: finalClass.pageClass,
          });
          await linkRepository.update(rejected.id, {
            final_url: finalUrl,
            status: LinkStatus.REJECTED_CROSS_CONTEXT,
            page_class: finalClass.pageClass,
            content_verified: false,
            error_message: `redirected into the other context: ${redirectCheck.reason}`,
          });
          result.crossContextRejected += 1;
          await logAction({
            university_id: university.id,
            discovered_link_id: rejected.id,
            action: CrawlAction.VALIDATE_LINK,
            status: "WARN",
            message: `fetch-rejected(cross-context redirect): ${request.url} → ${finalUrl} classified ${finalClass.pageClass} in ${context} crawl — result discarded (no snapshot, no parse, no export)`,
          });
          return;
        }

        const classification = classifyPage({ httpStatus, requestedUrl: request.url, page: extracted });
        // BOT-CHALLENGE = the strongest "slow down" signal there is (the CDN has
        // flagged us; hammering on extends the flag). Treat it like a 429 even
        // when the interstitial arrived with HTTP 200.
        if (adaptive && classification.reason === "bot-challenge") throttle.note("rateLimited");

        // Every VISITED page becomes a discovered-link row shown in "Review links",
        // so capture a screenshot for ALL of them — including low-score / low-
        // confidence pages — because reviewers need to see the page to judge it.
        // The heavy raw HTML + extracted text are kept only for pages relevant to
        // the ACTIVE context (eligibility: course/admission/requirement shapes;
        // scholarship: scholarship-classed pages); use the dashboard's Storage
        // cleanup to reclaim space after exporting.
        const parseableShape = isParseablePage(classification.status);
        const scholarshipClassed =
          finalClass.pageClass === PageClass.SCHOLARSHIP_PAGE ||
          finalClass.pageClass === PageClass.SCHOLARSHIP_LISTING ||
          finalClass.pageClass === PageClass.FUNDING_PAGE;
        const keepArtifacts =
          context === CrawlContext.ELIGIBILITY
            ? parseableShape
            : scholarshipClassed &&
              classification.status !== LinkStatus.BROKEN_LINK &&
              classification.status !== LinkStatus.BLOCKED;
        // EXPENSIVE ARTIFACT DEFERRAL (redesign Step 6): the proof screenshot is
        // captured ONLY after a page is confirmed a VALIDATED_TARGET — the single
        // most expensive per-page op (JPEG encode of the live viewport) must not
        // run on the thousands of discovery-only / rejected pages that are never
        // exported. Captured below, once `contentVerified` is known (the page is
        // still open in this handler). Review UI already tolerates a null shot.
        let screenshotPath: string | null = null;
        // Raw HTML + visible-text storage is OFF by default (STORE_PAGE_ARTIFACTS):
        // not part of the deliverable, and the parser reads the cleaned sections.
        const storeArtifacts = env.STORE_PAGE_ARTIFACTS && keepArtifacts;
        const htmlPath = storeArtifacts ? await storage.saveText(storagePaths.html(university.id, urlHash), extracted.raw_html) : null;
        const textPath = storeArtifacts ? await storage.saveText(storagePaths.text(university.id, urlHash), extracted.visible_text) : null;

        // Update the discovered-link row for this final URL.
        const link = await timeMs("dbWrite", () =>
          linkRepository.upsert({
            university_id: university.id,
            url: request.url,
            canonical_url: canonicalizeUrl(finalUrl),
            url_hash: urlHash,
            link_text: userData.linkText ?? extracted.page_title,
            link_score: userData.linkScore ?? 0,
            depth,
            status: classification.status,
            crawl_context: context,
            page_class: finalClass.pageClass,
          }),
        );
        // ENTRY-REQUIREMENTS ANCHOR (eligibility crawls only): from the HTML we
        // already have, find the anchor of this page's entry-requirements section/
        // tab/modal. The anchor is SUPPORTING METADATA — it never creates another
        // crawl target, never triggers another fetch, and never replaces the main
        // course URL: the primary/exported URL stays the main course page.
        const anchor = context === CrawlContext.ELIGIBILITY && keepArtifacts ? entryRequirementAnchor(extracted.raw_html) : null;

        const factCount = 0; // course-facts module removed — no facts extracted

        // Fingerprint this page (normalized text / title+anchor / sorted link set).
        fingerprints[canonicalizeUrl(finalUrl)] = {
          url: finalUrl,
          content_hash: sha256Hex(extracted.visible_text.replace(/\s+/g, " ").trim().normalize("NFC")),
          meta_hash: sha256Hex(`${extracted.page_title}${anchor ?? ""}`),
          links_hash: sha256Hex(
            [...new Set(extracted.internal_links.map((l) => canonicalizeUrl(l.url)))].sort(codepointCompare).join("\n"),
          ),
          updated_utc: new Date().toISOString(),
        };
        // TARGET VALIDATION (single pass, context-aware, explainable): course
        // IDENTITY is established before course-level eligibility EVIDENCE is
        // accepted; scholarship crawls validate scholarship identity + evidence.
        // Only VALIDATED_TARGET pages are exportable — general admissions/
        // eligibility/listing pages remain DISCOVERY_ONLY even when they contain
        // target keywords.
        const validateT = Date.now();
        const validation = validateTarget({
          context,
          finalUrl,
          pageClass: finalClass.pageClass,
          title: extracted.page_title,
          text: extracted.visible_text,
          hasEntryAnchor: !!anchor,
          factCount,
        });
        ms.validate += Date.now() - validateT;
        let contentVerified = validation.outcome === TargetOutcome.VALIDATED_TARGET;
        // ALIAS DEDUPE: identical content already validated under another URL →
        // this one is the same page on a second slug. Record it, but it is NOT a
        // second exportable target (no screenshot, no snapshot, no parse).
        let duplicateOf: string | null = null;
        if (contentVerified) {
          const canonicalFinal = canonicalizeUrl(finalUrl);
          const chash = fingerprints[canonicalFinal]!.content_hash;
          const prior = validatedContentHashes.get(chash);
          if (prior && prior !== canonicalFinal) {
            duplicateOf = prior;
            contentVerified = false;
            n.dup += 1;
          } else {
            validatedContentHashes.set(chash, canonicalFinal);
          }
        }
        if (contentVerified) result.validatedTargets += 1;
        else if (validation.outcome === TargetOutcome.DISCOVERY_ONLY || duplicateOf) result.discoveryOnlyPages += 1;

        // Proof screenshot for VALIDATED targets — OFF by default (CAPTURE_SCREENSHOTS).
        // It's the costliest per-target op; skipping it is the main speed win and,
        // together with inline fast-lane finalisation, removes the fragile post-crawl
        // browser phase that could leave a "completed" crawl with unrecorded targets.
        if (env.CAPTURE_SCREENSHOTS && contentVerified) {
          screenshotPath = await timeMs("screenshot", () =>
            captureScreenshot(page, university.id, urlHash, storage).catch(() => null),
          );
          if (screenshotPath) n.screenshot += 1;
        }

        // BRANCH-YIELD (Step 7): record this visit + whether it validated, so the
        // discovery gate below can stop expanding LOW-tier links from branches
        // that keep producing zero targets.
        branchYield.record(finalUrl, contentVerified);

        // The anchor deep-link ships ONLY as secondary metadata of a validated
        // COURSE target (tracking params stripped so one course can't appear
        // twice under different campaign junk). Primary URL = main course page.
        const eligibilityUrl =
          contentVerified && validation.targetType === "COURSE" && anchor
            ? deepLinkEligibility(stripTrackingParams(finalUrl), extracted.raw_html)
            : null;

        await timeMs("dbWrite", () => linkRepository.update(link.id, {
          final_url: finalUrl,
          eligibility_url: eligibilityUrl,
          page_title: extracted.page_title,
          http_status: httpStatus ?? undefined,
          // Alias pages carry a terminal DUPLICATE status so counters, exports
          // and future resumes all treat them as settled non-targets.
          status: duplicateOf ? LinkStatus.DUPLICATE : classification.status,
          page_class: finalClass.pageClass,
          content_verified: contentVerified,
          evidence: duplicateOf
            ? `duplicate content of ${duplicateOf} (same page under a second URL — one exported)`
            : validation.evidence || validation.reasons[0] || null,
          screenshot_path: screenshotPath,
          html_path: htmlPath,
          text_path: textPath,
        }));

        await logAction({
          university_id: university.id,
          discovered_link_id: link.id,
          action: CrawlAction.VALIDATE_LINK,
          status: "OK",
          message: `${classification.status} (${classification.reason}) · ${finalClass.pageClass} · ${validation.outcome}${
            contentVerified
              ? ` ✓ ${validation.targetType}${eligibilityUrl ? ` (anchor: ${eligibilityUrl})` : ""}`
              : duplicateOf
                ? ` — duplicate content of ${duplicateOf} (alias URL, not exported twice)`
                : ` — ${validation.reasons[0] ?? ""}`
          }`,
        });

        // Clean + chunk + enqueue parse ONLY for validated individual course
        // targets of an ELIGIBILITY crawl — the course-criteria parser must never
        // receive general admissions/eligibility pages, listings or scholarship
        // pages (those stay discovery surfaces, not parse inputs).
        if (context === CrawlContext.ELIGIBILITY && contentVerified && validation.targetType === "COURSE") {
          const cleanChunkT = Date.now();
          const cleaned = cleanContent(extracted);
          const sections = chunkSections(cleaned.blocks, {
            source_url: finalUrl,
            page_title: extracted.page_title,
            university_id: university.id,
          });

          const cleanedTextPath = await storage.saveText(
            `storage/text/${university.id}/${urlHash}.cleaned.txt`,
            cleaned.cleaned_text,
          );
          // Persist the section chunks so the (separately-throttled) parse job
          // can reconstruct the ParserInput without re-fetching the page.
          await storage.saveJson(`storage/text/${university.id}/${urlHash}.sections.json`, {
            cleaned_text: cleaned.cleaned_text,
            tables: cleaned.tables,
            sections,
          });

          const snapshot = await snapshotRepository.create({
            university_id: university.id,
            discovered_link_id: link.id,
            crawl_context: context,
            url: request.url,
            final_url: finalUrl,
            page_title: extracted.page_title,
            source_language: classification.source_language,
            raw_html_path: htmlPath,
            cleaned_text_path: cleanedTextPath,
            screenshot_path: screenshotPath,
            extracted_text: cleaned.cleaned_text.slice(0, 200000),
          });
          result.snapshots += 1;
          result.validLinks += 1;
          await bumpLiveStats(); // reflect each valid page live — cheap (DB count only)

          await snapshotRepository.findById(snapshot.id); // touch (no-op safety)
          await enqueueParse({ universityId: university.id, snapshotId: snapshot.id, crawlJobId, context });
          await logAction({
            university_id: university.id,
            discovered_link_id: link.id,
            action: CrawlAction.CHUNK_CONTENT,
            status: "OK",
            message: `${sections.length} sections chunked`,
          });
          ms.cleanChunk += Date.now() - cleanChunkT;
        }

        // Discovery — every child link goes through the fixed conceptual order:
        //   discover → normalize → dedupe → CLASSIFY → AUTHORIZE (context policy)
        //   → score → queue. Classification + authorization run BEFORE the URL
        //   can enter the request queue, and a cross-context rejection can never
        //   be overridden by a high relevance score. Rows are recorded in ONE
        //   batched DB insert (not one-write-per-link — throughput bottleneck).
        // Pagination links ("?page=2", "next") flow through this same gate, so
        // pagination inherits the context and cannot smuggle foreign pages in.
        if (depth >= env.MAX_CRAWL_DEPTH) return;
        const toEnqueue: { url: string; userData: CrawlUserData }[] = [];
        const newRows: Parameters<typeof linkRepository.createManyDiscovered>[0] = [];
        const rejectedSamples: string[] = [];
        // Gate + record + queue one authorized candidate (child link or the HTML
        // page chased from a PDF). Returns without queueing on any policy refusal.
        const considerChild = (url: string, text: string) => {
          const urlHash = hashUrl(url);
          if (seenHashes.has(urlHash)) return; // dedupe within this run
          if (skipOldEdition(url)) return; // older year-edition of a family we already crawl
          seenHashes.add(urlHash);
          const gate = gateUrl({ url, anchorText: text, parentUrl: finalUrl }, context);
          if (!gate.decision.allowed) {
            if (gate.decision.crossContext) {
              // Discovered + classified + REFUSED before fetch: record the audit
              // row; the URL never reaches the queue, Playwright, or the network.
              rejectCrossContext(newRows, url, text, depth + 1, gate);
              if (rejectedSamples.length < 3) rejectedSamples.push(`${url} [${gate.classification.pageClass}]`);
            }
            return; // IRRELEVANT/DOCUMENT: dropped silently (same as before)
          }
          // Authorized → NOW relevance scoring may decide priority/queueing.
          const { score } = scoreLink({ url, anchorText: text, baseUrl: university.base_url, context });
          const disposition = dispositionFor(score, env.MIN_LINK_SCORE);
          if (disposition === "SKIP") return; // generic page — don't follow/record
          // STOP LOW-VALUE CRAWLING (Step 7): a LOW-tier discover-only link whose
          // branch has proven barren (many visits, zero validated targets) leads
          // only to more of the same — don't follow it. EXTRACT-tier course/
          // eligibility/scholarship candidates are NEVER pruned (coverage first).
          if (env.PRUNE_DEAD_BRANCHES && disposition === "DISCOVER_ONLY" && branchYield.isDead(url)) {
            branchesPruned += 1;
            return;
          }
          // CATALOG-DRIVEN SCOPE (see crawlScope.ts): only follow target
          // candidates, target listings/finders, and course-section hubs — skip
          // (don't record) generic low-value pages the sitemap/catalogue already
          // makes unnecessary. Same policy as the fast lane.
          if (!shouldFetchForDiscovery({ url, pageClass: gate.classification.pageClass, disposition, depth: depth + 1, catalogDriven: env.CATALOG_DRIVEN_CRAWL })) {
            scopeSkipped += 1;
            return;
          }
          result.urlsAuthorized += 1;
          const status = disposition === "EXTRACT" ? LinkStatus.QUEUED : LinkStatus.LOW_CONFIDENCE_PAGE;
          newRows.push({
            university_id: university.id,
            url,
            url_hash: urlHash,
            canonical_url: canonicalizeUrl(url),
            link_text: text,
            link_score: score,
            depth: depth + 1,
            status,
            crawl_context: context,
            page_class: gate.classification.pageClass,
          });
          toEnqueue.push({
            url,
            userData: { depth: depth + 1, linkScore: score, linkText: text, context, pageClass: gate.classification.pageClass, parentUrl: finalUrl },
          });
        };
        // Year-edition pre-pass over THIS page's links (order-independence within
        // the page): a handbook page links every year edition side by side —
        // record each family's newest year first so ascending-order links
        // (2023 → 2027) can't each slip past the gate as "newer than the last".
        for (const l of extracted.internal_links) yearGate.observe(l.url);
        for (const u of finderJsonUrls) yearGate.observe(u);
        for (const { url, text } of extracted.internal_links) {
          if (!isSameDomain(url, university.base_url)) continue;
          if (isResume && isDone(url)) continue; // already crawled in a prior run — don't re-queue
          const f = filterLink(url);
          if (f.rejected && !f.isPdf) continue;
          if (f.isPdf) {
            const urlHash = hashUrl(url);
            if (seenHashes.has(urlHash)) continue;
            seenHashes.add(urlHash);
            // PDFs are recorded but NEVER fetched (deferred documents).
            newRows.push({ university_id: university.id, url, url_hash: urlHash, canonical_url: canonicalizeUrl(url), link_text: text, link_score: 0, depth: depth + 1, status: LinkStatus.PDF_DEFERRED, crawl_context: context, page_class: PageClass.DOCUMENT });
            // HTML-FIRST: also chase the HTML course page this PDF belongs to —
            // through the SAME classify+authorize gate as every other child (a
            // scholarship crawl must not chase PDF-derived course pages).
            const htmlPage = htmlPageFromPdf(url);
            if (htmlPage && isSameDomain(htmlPage, university.base_url) && !(isResume && isDone(htmlPage))) {
              considerChild(htmlPage, text);
            }
            continue;
          }
          considerChild(url, text);
        }
        // FINDER JSON links (Step 5): course/scholarship URLs pulled from the
        // page's embedded JSON, run through the exact same same-domain + filter +
        // classify + authorize + score gate as DOM links (no shortcut past policy).
        for (const url of finderJsonUrls) {
          if (!isSameDomain(url, university.base_url)) continue;
          if (isResume && isDone(url)) continue;
          if (filterLink(url).rejected) continue;
          considerChild(url, "");
        }
        if (newRows.length) result.linksFound += await timeMs("dbWrite", () => linkRepository.createManyDiscovered(newRows));
        if (rejectedSamples.length) {
          await logAction({
            university_id: university.id,
            discovered_link_id: link.id,
            action: CrawlAction.DISCOVER_LINKS,
            status: "OK",
            message: `fetch-rejected(cross-context): ${rejectedSamples.length}+ URL(s) on this page classified as the other context and blocked BEFORE fetch (0 network requests) in ${context} crawl — e.g. ${rejectedSamples.join(" · ")}`,
          }).catch(() => {});
        }
        if (++pagesSinceRecount >= 40) await flushCounters(); // refresh live counters (debounced)
        // STRICT 3-TIER PRIORITY so the time budget never costs accuracy:
        //   TOP  (≥60): eligibility / admission / international / entry-requirements
        //              HUBS — the pages that DEFINE eligibility. Crawled first.
        //   MID  (40–59): individual course / programme pages.
        //   LOW  (20–39): section pages that merely lead toward the above.
        // Each tier is enqueued forefront in reverse, so TOP sits at the very front
        // of the frontier — guaranteeing the eligibility SOURCES are captured
        // before thousands of course-detail pages, even on huge sites within 40 min.
        const TOP = 60;
        const top = toEnqueue.filter((r) => (r.userData.linkScore ?? 0) >= TOP);
        const mid = toEnqueue.filter((r) => { const s = r.userData.linkScore ?? 0; return s >= env.MIN_LINK_SCORE && s < TOP; });
        const low = toEnqueue.filter((r) => (r.userData.linkScore ?? 0) < env.MIN_LINK_SCORE);
        if (mid.length) await ctx.addRequests(mid.map((r) => ({ url: r.url, userData: r.userData })), { forefront: true });
        if (top.length) await ctx.addRequests(top.map((r) => ({ url: r.url, userData: r.userData })), { forefront: true }); // added last → very front
        if (low.length) await ctx.addRequests(low.map((r) => ({ url: r.url, userData: r.userData })));
      },
      async failedRequestHandler({ request }, error) {
        const urlHash = hashUrl(request.url);
        // The defensive pre-navigation gate blocked this request (stale/foreign
        // queue entry that violates the crawl context). NOT a broken link: record
        // it as cross-context-rejected — it was never fetched.
        if (String(error?.message ?? error).includes(CROSS_CONTEXT_FETCH_BLOCKED)) {
          result.crossContextRejected += 1;
          try {
            const link = await linkRepository.upsert({
              university_id: university.id,
              url: request.url,
              url_hash: urlHash,
              status: LinkStatus.REJECTED_CROSS_CONTEXT,
              crawl_context: context,
            });
            await linkRepository.update(link.id, {
              status: LinkStatus.REJECTED_CROSS_CONTEXT,
              content_verified: false,
              error_message: String(error?.message ?? error).slice(0, 500),
            });
            await logAction({
              university_id: university.id,
              discovered_link_id: link.id,
              action: CrawlAction.EXTRACT_PAGE,
              status: "WARN",
              message: `fetch-rejected(cross-context, pre-navigation guard): ${request.url} blocked before any network request in ${context} crawl`,
            });
          } catch {
            /* logging failure must not crash the crawl */
          }
          return;
        }
        n.dead += 1; // genuine broken/timed-out page (not a cross-context refusal)
        if (adaptive) throttle.note("timeout"); // repeated failures → back off
        const human = humanizeError(error); // plain-English reason for the user
        try {
          const link = await linkRepository.upsert({
            university_id: university.id,
            url: request.url,
            url_hash: urlHash,
            status: LinkStatus.BROKEN_LINK,
            crawl_context: context,
          });
          await linkRepository.update(link.id, {
            status: LinkStatus.BROKEN_LINK,
            error_message: human,
            retry_count: { increment: 1 },
          });
          await logAction({
            university_id: university.id,
            discovered_link_id: link.id,
            action: CrawlAction.EXTRACT_PAGE,
            status: "ERROR",
            message: `${human} — ${request.url}`,
            error_stack: error instanceof Error ? error.stack : undefined,
          });
        } catch {
          /* logging failure must not crash the crawl */
        }
      },
    },
    config,
  );

  // Seed with the base URL.
  await recordDiscovery(university.base_url, university.name, 100, 0, LinkStatus.QUEUED, PageClass.NAVIGATION_PAGE);
  await universityRepository.updateCrawlStatus(university.id, "DISCOVERING");
  await logAction({
    university_id: university.id,
    action: CrawlAction.DISCOVER_LINKS,
    status: "OK",
    message: `Crawl started — context: ${context} (${context === CrawlContext.ELIGIBILITY ? "final targets = individual course/programme pages" : "final targets = scholarship pages"}; cross-context URLs are rejected before fetch)`,
  }).catch(() => {});

  // Sitemap seeding (full course inventory). Records every relevant URL so none
  // are silently missed, and queues the top ones for full page visits.
  const seeds: { url: string; userData: CrawlUserData }[] = [];
  // Sitemap census runs ONCE per crawl: on a RESUME the census is already in the
  // DB (discovered links) and re-fetching every sitemap costs ~2 min of browser
  // work per restart — with the stall-recovery loop that tax was paid 50+ times.
  const needSitemap = process.env.ENABLE_SITEMAP !== "false" && (!isResume || doneUrls.size < 50);
  if (needSitemap) {
    try {
      const smUrls = await timeMs("sitemap", () => discoverSitemapUrls(university.base_url, 20000, env.HTTP_FIRST_DISCOVERY));
      // Year-edition pre-pass (order-independent): record each family's newest
      // edition first, so the filter below keeps exactly one URL per family.
      for (const url of smUrls) yearGate.observe(url);
      const smRows: Parameters<typeof linkRepository.createManyDiscovered>[0] = [];
      let seeded = 0;
      let smRejected = 0;
      for (const url of smUrls) {
        if (!isSameDomain(url, university.base_url)) continue;
        const f = filterLink(url);
        const urlHash = hashUrl(url);
        if (seenHashes.has(urlHash)) continue;
        if (skipOldEdition(url)) continue; // older year-edition — newest is seeded instead
        if (f.isPdf) {
          seenHashes.add(urlHash);
          smRows.push({ university_id: university.id, url, url_hash: urlHash, canonical_url: canonicalizeUrl(url), link_text: "(sitemap pdf)", link_score: 0, depth: 1, status: LinkStatus.PDF_DEFERRED, crawl_context: context, page_class: PageClass.DOCUMENT });
          continue;
        }
        if (f.rejected) continue;
        // CLASSIFY + AUTHORIZE before the sitemap URL may become a seed — the
        // sitemap is just another discovery source and obeys the same context
        // policy (a SCHOLARSHIP crawl never seeds course-catalog pages).
        const gate = gateUrl({ url }, context);
        if (!gate.decision.allowed) {
          if (gate.decision.crossContext) {
            seenHashes.add(urlHash);
            rejectCrossContext(smRows, url, "(sitemap)", 1, gate);
            smRejected += 1;
          }
          continue;
        }
        const { score } = scoreLink({ url, anchorText: "", baseUrl: university.base_url, context });
        // GUARANTEED COURSE COVERAGE (eligibility crawls): a course-catalog page
        // (/courses, /programmes, /programs, /degrees) is ALWAYS seeded from the
        // sitemap — even below MIN_LINK_SCORE — so no hyperparameter value can
        // ever cause a real course to be skipped. The sitemap is the
        // authoritative course inventory; only NON-catalog URLs are score-gated.
        // (Non-course pages under the catalog, e.g. short-courses/CPD, are still
        // filtered out later at export time.)
        const isCatalog =
          context === CrawlContext.ELIGIBILITY && /\/(courses?|programmes?|programs?|degrees?)\//i.test(url.toLowerCase());
        if (!isCatalog && score < env.MIN_LINK_SCORE) continue;
        seenHashes.add(urlHash);
        result.urlsAuthorized += 1;
        const seedScore = isCatalog ? Math.max(score, env.MIN_LINK_SCORE) : score;
        smRows.push({ university_id: university.id, url, url_hash: urlHash, canonical_url: canonicalizeUrl(url), link_text: "(sitemap)", link_score: seedScore, depth: 1, status: LinkStatus.QUEUED, crawl_context: context, page_class: gate.classification.pageClass });
        seeded += 1;
        // Course-catalog seeds are never dropped by the visit cap (added first/forefront).
        if (isCatalog || seeds.length < 3000) seeds.push({ url, userData: { depth: 1, linkScore: seedScore, linkText: "(sitemap)", context, pageClass: gate.classification.pageClass } });
      }
      if (smRows.length) result.linksFound += await linkRepository.createManyDiscovered(smRows);
      if (smRejected) {
        await logAction({
          university_id: university.id,
          action: CrawlAction.DISCOVER_LINKS,
          status: "OK",
          message: `sitemap: ${smRejected} URL(s) classified as the other context and blocked BEFORE fetch (${context} crawl)`,
        }).catch(() => {});
      }
      if (seeded) {
        await logAction({
          university_id: university.id,
          action: CrawlAction.DISCOVER_LINKS,
          status: "OK",
          message: `sitemap: seeded ${seeded} relevant URLs`,
        });
      }
    } catch {
      /* sitemap is best-effort */
    }
  }

  // TARGET-SOURCE PROBING (redesign Step 4): before broad graph-crawling, go
  // straight to the course/scholarship INVENTORIES. Cheap HTTP probes (no
  // browser) confirm which likely catalogue / finder / directory URLs actually
  // resolve; survivors are seeded at TOP priority through the same
  // classify→authorize gate as any other URL, so context isolation holds. This
  // is what turns "crawl the whole site until targets appear" into "find the
  // source first" — hundreds of targets can then be pulled from one inventory.
  const needProbe = env.HTTP_FIRST_DISCOVERY && (!isResume || doneUrls.size < 50);
  if (needProbe) {
    try {
      const live = await timeMs("sitemap", () => probeTargetSources(university.base_url, context));
      const tsRows: Parameters<typeof linkRepository.createManyDiscovered>[0] = [];
      let tsSeeded = 0;
      for (const url of live) {
        if (!isSameDomain(url, university.base_url)) continue;
        const urlHash = hashUrl(url);
        if (seenHashes.has(urlHash)) continue;
        if (filterLink(url).rejected) continue;
        const gate = gateUrl({ url }, context);
        if (!gate.decision.allowed) {
          if (gate.decision.crossContext) {
            seenHashes.add(urlHash);
            rejectCrossContext(tsRows, url, "(target-source)", 1, gate);
          }
          continue;
        }
        seenHashes.add(urlHash);
        // These pages ARE the inventories — seed at TOP priority so they're
        // crawled first and their target links fan out before generic nav pages.
        const { score } = scoreLink({ url, anchorText: "", baseUrl: university.base_url, context });
        const seedScore = Math.max(score, 60);
        result.urlsAuthorized += 1;
        tsRows.push({ university_id: university.id, url, url_hash: urlHash, canonical_url: canonicalizeUrl(url), link_text: "(target-source)", link_score: seedScore, depth: 1, status: LinkStatus.QUEUED, crawl_context: context, page_class: gate.classification.pageClass });
        seeds.push({ url, userData: { depth: 1, linkScore: seedScore, linkText: "(target-source)", context, pageClass: gate.classification.pageClass } });
        tsSeeded += 1;
      }
      if (tsRows.length) result.linksFound += await linkRepository.createManyDiscovered(tsRows);
      if (tsSeeded) {
        await logAction({
          university_id: university.id,
          action: CrawlAction.DISCOVER_LINKS,
          status: "OK",
          message: `target-source probe: seeded ${tsSeeded} live ${context === CrawlContext.SCHOLARSHIP ? "scholarship/funding" : "course catalogue/finder"} inventory URL(s) before broad crawl`,
        });
      }
    } catch {
      /* target-source probing is best-effort */
    }
  }

  // RESUME: re-seed the pending frontier (links discovered but not yet visited
  // last time) so the crawl continues from where it stopped. Every recovered URL
  // re-passes classification + authorization: old rows queued before a policy
  // change (or by another producer) can never smuggle a cross-context page past
  // the gate — recovery obeys the same rules as fresh discovery.
  if (isResume) {
    let resumeRejected = 0;
    let resumeEditionsSkipped = 0;
    // Year-edition pre-pass over the WHOLE pending frontier (order-independent):
    // a five-year handbook archive collapses to its newest edition instead of
    // re-seeding thousands of near-duplicate pages on every resume.
    for (const p of pendingFrontier) yearGate.observe(p.url);
    for (const p of pendingFrontier) {
      if (isDone(p.url)) continue;
      // Filters evolve between runs (e.g. subject/unit pages are now hard-rejected):
      // never re-queue a pending URL the CURRENT filters would reject — this is what
      // stops a resumed crawl from burning hours on thousands of stale frontier rows.
      if (filterLink(p.url).rejected) continue;
      if (skipOldEdition(p.url)) {
        resumeEditionsSkipped += 1;
        continue;
      }
      const gate = gateUrl({ url: p.url, anchorText: p.text }, context);
      if (!gate.decision.allowed) {
        if (gate.decision.crossContext) {
          resumeRejected += 1;
          result.crossContextRejected += 1;
          await linkRepository
            .upsert({ university_id: university.id, url: p.url, url_hash: hashUrl(p.url), status: LinkStatus.REJECTED_CROSS_CONTEXT, crawl_context: context, page_class: gate.classification.pageClass })
            .then((row) => linkRepository.update(row.id, { status: LinkStatus.REJECTED_CROSS_CONTEXT, page_class: gate.classification.pageClass, error_message: gate.decision.reason }))
            .catch(() => {});
        }
        continue;
      }
      // CATALOG-DRIVEN SCOPE on resume too: a stale LOW-tier frontier row that
      // the current policy would never follow (generic non-hub page) must not be
      // re-crawled just because a prior run recorded it — otherwise the resume
      // spends hours re-fetching exactly the pages this optimization skips.
      // Target candidates and hubs (score/class) are unaffected.
      const rDisposition = dispositionFor(p.score, env.MIN_LINK_SCORE);
      if (!shouldFetchForDiscovery({ url: p.url, pageClass: gate.classification.pageClass, disposition: rDisposition, depth: 2, catalogDriven: env.CATALOG_DRIVEN_CRAWL })) {
        scopeSkipped += 1;
        continue;
      }
      result.urlsAuthorized += 1;
      seeds.push({ url: p.url, userData: { depth: 1, linkScore: p.score, linkText: "(resumed)", context, pageClass: gate.classification.pageClass } });
    }
    await logAction({
      university_id: university.id,
      action: CrawlAction.DISCOVER_LINKS,
      status: "OK",
      message: `Resuming ${context} crawl — ${doneUrls.size} pages already done, ${pendingFrontier.length} pending to continue${resumeRejected ? `, ${resumeRejected} stale frontier URL(s) blocked as cross-context before fetch` : ""}${resumeEditionsSkipped ? `, ${resumeEditionsSkipped} older year-edition duplicate(s) collapsed to their newest edition` : ""}.`,
    });
  }

  // =========================================================================
  // FAST LANE (redesign Step 3, full form — the time-complexity fix).
  //
  //   old:  every page = one Chromium navigation           → O(N)·T_browser
  //   new:  every page = one plain HTTP fetch + parse      → O(N)·T_http
  //         browser reserved for the pages that NEED it    → O(V)·T_browser
  //         (V = validated targets + JS shells + challenges + dynamic finders,
  //          typically 10–15% of N; T_http ≈ 0.2–0.5s vs T_browser ≈ 3–8s)
  //
  // The JOB is unchanged: every URL passes the same classify → authorize →
  // fetch → validate → persist pipeline, all three isolation guards run, the
  // same rows/artifacts/exports are produced. Pages the fast lane cannot serve
  // faithfully are ESCALATED to the browser lane — never dropped — and
  // validated targets are always escalated so their proof screenshot and
  // parse-grade snapshot come from a real render.
  // =========================================================================
  const rootRequest = { url: university.base_url, userData: { depth: 0, linkScore: 100, linkText: university.name, context, pageClass: PageClass.NAVIGATION_PAGE } satisfies CrawlUserData };
  type FastReq = { url: string; userData: CrawlUserData };
  const escalatedRequests: FastReq[] = [];
  let fastBlockedCount = 0; // pages the fast lane recorded BLOCKED instead of browser-escalating

  const runFastLane = async (initial: FastReq[]): Promise<void> => {
    const FAST_CONCURRENCY = Math.max(1, env.FAST_LANE_CONCURRENCY);
    const TOP = 60;
    const qTop: FastReq[] = [];
    const qMid: FastReq[] = [];
    const qLow: FastReq[] = [];
    const pushTiered = (r: FastReq) => {
      const s = r.userData.linkScore ?? 0;
      if (s >= TOP) qTop.push(r);
      else if (s >= env.MIN_LINK_SCORE) qMid.push(r);
      else qLow.push(r);
    };
    for (const r of initial) pushTiered(r);
    const pop = (): FastReq | undefined => qTop.shift() ?? qMid.shift() ?? qLow.shift();

    const escalatedSeen = new Set<string>();
    const escalate = (r: FastReq, reason: keyof typeof esc) => {
      if (escalatedSeen.has(r.url)) return;
      escalatedSeen.add(r.url);
      esc[reason] += 1;
      escalatedRequests.push(r);
    };

    // BOT-PROTECTION SHORT-CIRCUIT: instead of escalating a Cloudflare-challenged
    // / 403-429-503 page to the slow browser lane (where a headless browser
    // almost never solves a managed challenge, so it just grinds ~5 pages/min
    // for near-zero yield AND keeps hammering the flagged host), record it as
    // BLOCKED right here — fast. The coverage-recovery pass re-crawls every
    // BLOCKED row via the FAST lane on the next run, once the host has cleared,
    // so no coverage is lost; it's deferred, not dropped. Gated by
    // ESCALATE_BOT_BLOCKS (default off = this fast path).
    const markBlockedFast = async (r: FastReq, reason: string): Promise<void> => {
      if (escalatedSeen.has(r.url)) return;
      escalatedSeen.add(r.url);
      fastBlockedCount += 1;
      try {
        const row = await linkRepository.upsert({ university_id: university.id, url: r.url, url_hash: hashUrl(r.url), status: LinkStatus.BLOCKED, crawl_context: context });
        await linkRepository.update(row.id, { status: LinkStatus.BLOCKED, error_message: `bot-protection (${reason}) — not browser-escalated; the fast lane re-crawls it once the host clears (coverage recovery)` });
      } catch { /* audit row is best-effort — never fail the crawl over it */ }
    };

    // Per-registrable-domain pacing: max(politeness floor, adaptive backoff,
    // 150ms). Even the fast lane must not burst — that's how IPs get flagged.
    const lastAt = new Map<string, number>();
    const sleep = (ms2: number) => new Promise<void>((r) => setTimeout(r, ms2));
    const acquireSlot = async (host: string) => {
      const dom = registrableDomain(host);
      for (;;) {
        const gap = Math.max(env.CRAWL_MIN_DELAY_MS, throttle.delayMs, 150);
        const at = lastAt.get(dom) ?? 0;
        const now = Date.now();
        if (now >= at + gap) {
          lastAt.set(dom, now); // single-threaded between awaits → safe
          return;
        }
        await sleep(at + gap - now);
      }
    };

    // robots.txt per host (the browser lane's Crawlee enforcement doesn't cover
    // fast-lane fetches). A challenged robots means the HOST needs the browser.
    const robotsCache = new Map<string, RobotsRules | "challenged" | "none">();
    const robotsFor = async (origin: string, host: string): Promise<RobotsRules | "challenged" | "none"> => {
      const hit = robotsCache.get(host);
      if (hit) return hit;
      const res = await httpFetchPage(`${origin}/robots.txt`, SITEMAP_HEADERS, 6000);
      let out: RobotsRules | "challenged" | "none";
      if (!res.ok || !res.body) out = "none";
      else if (looksLikeBotChallenge(res.body.slice(0, 8000))) out = "challenged";
      else out = parseRobotsTxt(res.body);
      robotsCache.set(host, out);
      return out;
    };

    const handleFast = async (r: FastReq): Promise<void> => {
      // PAGE BUDGET: stop the WHOLE lane honestly (done=true) instead of
      // silently swallowing each remaining queue item. The old per-item return
      // drained thousands of entries as no-ops, the lane looked "idle", and the
      // university got marked COMPLETED with a huge frontier still pending —
      // the observed "completed 100% but not actually crawled". Unprocessed
      // rows are already QUEUED in the DB, so a resume continues exactly here;
      // the caller sees stoppedAtBudget/pendingRemaining and records STOPPED.
      if (result.pagesVisited >= env.MAX_PAGES_PER_UNIVERSITY) {
        if (!result.stoppedAtBudget) {
          result.stoppedAtBudget = true;
          await logAction({ university_id: university.id, action: CrawlAction.DISCOVER_LINKS, status: "WARN", message: `Page budget reached (MAX_PAGES_PER_UNIVERSITY=${env.MAX_PAGES_PER_UNIVERSITY}) — stopping this ${context} crawl with pages still pending. Click Resume to continue where it left off, or raise the budget in Settings to crawl bigger sites in one go.` }).catch(() => {});
        }
        done = true;
        return;
      }
      if (Date.now() > softTargetAt && !targetNoticeLogged) {
        targetNoticeLogged = true;
        await logAction({ university_id: university.id, action: CrawlAction.DISCOVER_LINKS, status: "OK", message: `Target crawl time (${env.MAX_CRAWL_MINUTES} min) exceeded — continuing until every discovered page is crawled (no data is dropped).` }).catch(() => {});
      }
      const ud = r.userData;
      let host: string;
      let origin: string;
      let path: string;
      try {
        const u = new URL(r.url);
        host = u.hostname;
        origin = u.origin;
        path = u.pathname + u.search;
      } catch {
        return; // malformed URL — never fetchable
      }

      // GUARD 2 (pre-fetch): same defensive re-authorization the browser lane
      // runs in its pre-navigation hook.
      if (ud.context && ud.context !== context) return;
      if ((ud.depth ?? 0) > 0) {
        const check = authorizeFetch(ud.pageClass ?? classifyUrl({ url: r.url, anchorText: ud.linkText }).pageClass, context);
        if (!check.allowed && check.crossContext) {
          result.crossContextRejected += 1;
          await linkRepository
            .upsert({ university_id: university.id, url: r.url, url_hash: hashUrl(r.url), status: LinkStatus.REJECTED_CROSS_CONTEXT, crawl_context: context })
            .then((row) => linkRepository.update(row.id, { status: LinkStatus.REJECTED_CROSS_CONTEXT, content_verified: false, error_message: check.reason }))
            .catch(() => {});
          return;
        }
      }

      // robots.txt (fast lane's own enforcement). A robots.txt that we CAN'T
      // read cleanly (a bot-challenge on robots itself, or a policy 403 — e.g.
      // study.csu.edu.au serves `Disallow: /robots.txt` under a 403) tells us
      // NOTHING about whether the actual pages are fetchable. Do NOT block every
      // page on the host over it — just proceed with no robots rule and let the
      // real page fetch below decide (assessFastFetch marks a page BLOCKED only
      // if the PAGE itself is challenged). Blocking on a weird robots.txt was
      // recording whole hosts BLOCKED with 0 fetch attempts (observed live:
      // SCHOLARSHIP crawl fetched 0 pages, 85 marked blocked on robots alone).
      const robots = await robotsFor(origin, host);
      if (robots !== "none" && robots !== "challenged" && !robotsAllows(robots, path)) {
        await linkRepository
          .upsert({ university_id: university.id, url: r.url, url_hash: hashUrl(r.url), status: LinkStatus.BLOCKED, crawl_context: context })
          .then((row) => linkRepository.update(row.id, { status: LinkStatus.BLOCKED, error_message: "skipped before fetch: robots.txt disallows this path" }))
          .catch(() => {});
        return;
      }

      await acquireSlot(host);
      const res = await httpFetchPage(r.url, SITEMAP_HEADERS, 15000);
      n.httpFetch += 1;

      // GUARD 3 (post-redirect): re-classify the FINAL url before anything else.
      if (res.ok) {
        const finalClass0 = classifyUrl({ url: res.finalUrl, anchorText: ud.linkText });
        const redirectCheck = authorizeFetch(finalClass0.pageClass, context);
        if (!redirectCheck.allowed && redirectCheck.crossContext) {
          result.crossContextRejected += 1;
          const rejected = await linkRepository.upsert({
            university_id: university.id,
            url: r.url,
            canonical_url: canonicalizeUrl(res.finalUrl),
            url_hash: hashUrl(res.finalUrl),
            link_text: ud.linkText,
            depth: ud.depth,
            status: LinkStatus.REJECTED_CROSS_CONTEXT,
            crawl_context: context,
            page_class: finalClass0.pageClass,
          });
          await linkRepository.update(rejected.id, { final_url: res.finalUrl, status: LinkStatus.REJECTED_CROSS_CONTEXT, page_class: finalClass0.pageClass, content_verified: false, error_message: `redirected into the other context: ${redirectCheck.reason}` }).catch(() => {});
          return;
        }
      }

      const extractT = Date.now();
      const extracted = res.ok && res.body ? extractFromHtml(res.body, r.url, res.finalUrl) : null;
      ms.extract += Date.now() - extractT;

      const assessment = assessFastFetch(res, extracted?.visible_text.length ?? 0);
      if (!assessment.serveFast) {
        if (assessment.reason === "bot-challenge") {
          if (adaptive && !env.ESCALATE_BOT_BLOCKS) throttle.note("rateLimited");
          return env.ESCALATE_BOT_BLOCKS ? escalate(r, "challenge") : markBlockedFast(r, "challenge");
        }
        if (assessment.reason === "blocked-status") {
          if (adaptive && !env.ESCALATE_BOT_BLOCKS) throttle.note(signalFor(res.status));
          return env.ESCALATE_BOT_BLOCKS ? escalate(r, "blocked") : markBlockedFast(r, `http-${res.status}`);
        }
        if (assessment.reason === "network") return escalate(r, "network");
        return escalate(r, "thin"); // JS shell — needs a real render
      }
      if (adaptive) throttle.note(signalFor(res.status));

      const finalUrl = res.finalUrl;
      const finalClass = classifyUrl({ url: finalUrl, anchorText: ud.linkText });

      // Dynamic finder needing expansion? Only listing/nav/unknown classes may
      // expand (mirror of the browser lane's mayExpandFinder gate) — and only
      // when the embedded JSON doesn't already expose the result set.
      const mayExpand =
        finalClass.pageClass !== PageClass.COURSE_PAGE &&
        finalClass.pageClass !== PageClass.SCHOLARSHIP_PAGE &&
        finalClass.pageClass !== PageClass.ELIGIBILITY_PAGE &&
        finalClass.pageClass !== PageClass.ADMISSIONS_PAGE &&
        finalClass.pageClass !== PageClass.INTERNATIONAL_ADMISSIONS_PAGE;
      let finderJsonUrls: string[] = [];
      if (mayExpand && looksLikeDynamicFinder(res.body)) {
        finderJsonUrls = extractLinksFromJson(res.body, finalUrl);
        if (finderJsonUrls.length < 15) return escalate(r, "finder"); // needs browser expansion
        n.finder += 1; // JSON-served finder — no browser needed
      }

      const extractedPage = extracted!;
      const urlHash = hashUrl(finalUrl);
      const classification = classifyPage({ httpStatus: res.status, requestedUrl: r.url, page: extractedPage });

      // Same artifact policy as the browser lane (screenshots are validated-only
      // and validated pages escalate, so the fast lane never screenshots).
      const parseableShape = isParseablePage(classification.status);
      const scholarshipClassed =
        finalClass.pageClass === PageClass.SCHOLARSHIP_PAGE ||
        finalClass.pageClass === PageClass.SCHOLARSHIP_LISTING ||
        finalClass.pageClass === PageClass.FUNDING_PAGE;
      const keepArtifacts =
        context === CrawlContext.ELIGIBILITY
          ? parseableShape
          : scholarshipClassed && classification.status !== LinkStatus.BROKEN_LINK && classification.status !== LinkStatus.BLOCKED;

      const anchor = context === CrawlContext.ELIGIBILITY && keepArtifacts ? entryRequirementAnchor(extractedPage.raw_html) : null;
      const factCount = 0; // course-facts module removed — no facts extracted
      fingerprints[canonicalizeUrl(finalUrl)] = {
        url: finalUrl,
        content_hash: sha256Hex(extractedPage.visible_text.replace(/\s+/g, " ").trim().normalize("NFC")),
        meta_hash: sha256Hex(`${extractedPage.page_title}${anchor ?? ""}`),
        links_hash: sha256Hex([...new Set(extractedPage.internal_links.map((l) => canonicalizeUrl(l.url)))].sort(codepointCompare).join("\n")),
        updated_utc: new Date().toISOString(),
      };

      const validateT = Date.now();
      const validation = validateTarget({
        context,
        finalUrl,
        pageClass: finalClass.pageClass,
        title: extractedPage.page_title,
        text: extractedPage.visible_text,
        hasEntryAnchor: !!anchor,
        factCount,
      });
      ms.validate += Date.now() - validateT;

      let validatedInline = false;
      if (validation.outcome === TargetOutcome.VALIDATED_TARGET) {
        const canonicalFinal = canonicalizeUrl(finalUrl);
        const chash = fingerprints[canonicalFinal]!.content_hash;
        const prior = validatedContentHashes.get(chash);
        if (prior && prior !== canonicalFinal) {
          // Alias of an already-validated page: final here — one exported.
          n.dup += 1;
          result.discoveryOnlyPages += 1;
          result.pagesVisited += 1;
          const aliasRow = await timeMs("dbWrite", () =>
            linkRepository.upsert({ university_id: university.id, url: r.url, canonical_url: canonicalFinal, url_hash: urlHash, link_text: ud.linkText ?? extractedPage.page_title, link_score: ud.linkScore ?? 0, depth: ud.depth, status: LinkStatus.DUPLICATE, crawl_context: context, page_class: finalClass.pageClass }),
          );
          await timeMs("dbWrite", () => linkRepository.update(aliasRow.id, { final_url: finalUrl, page_title: extractedPage.page_title, http_status: res.status ?? undefined, status: LinkStatus.DUPLICATE, page_class: finalClass.pageClass, content_verified: false, evidence: `duplicate content of ${prior} (same page under a second URL — one exported)` }));
          return;
        }
        // PRIMARY target. With screenshots ON, hand to the browser lane for the
        // proof shot (it claims the hash + finalises there). With screenshots OFF
        // (default), claim the hash and finalise INLINE here — no browser
        // round-trip, and the validation is recorded NOW (not in a later browser
        // phase that could fail and leave the crawl "completed" but unvalidated).
        if (env.CAPTURE_SCREENSHOTS) return escalate(r, "validated");
        validatedContentHashes.set(chash, canonicalFinal);
        validatedInline = true;
      }

      // RECORD the page (validated inline OR discovery-only), then discover links.
      result.pagesVisited += 1;
      if (validatedInline) result.validatedTargets += 1;
      else if (validation.outcome === TargetOutcome.DISCOVERY_ONLY) result.discoveryOnlyPages += 1;
      branchYield.record(finalUrl, validatedInline);

      const storeArtifacts = env.STORE_PAGE_ARTIFACTS && keepArtifacts;
      const htmlPath = storeArtifacts ? await storage.saveText(storagePaths.html(university.id, urlHash), extractedPage.raw_html) : null;
      const textPath = storeArtifacts ? await storage.saveText(storagePaths.text(university.id, urlHash), extractedPage.visible_text) : null;
      // Entry-requirements anchor deep-link — secondary metadata of a validated
      // COURSE target (the primary/exported URL stays the main course page).
      const eligibilityUrl =
        validatedInline && validation.targetType === "COURSE" && anchor
          ? deepLinkEligibility(stripTrackingParams(finalUrl), extractedPage.raw_html)
          : null;
      const link = await timeMs("dbWrite", () =>
        linkRepository.upsert({ university_id: university.id, url: r.url, canonical_url: canonicalizeUrl(finalUrl), url_hash: urlHash, link_text: ud.linkText ?? extractedPage.page_title, link_score: ud.linkScore ?? 0, depth: ud.depth, status: classification.status, crawl_context: context, page_class: finalClass.pageClass }),
      );
      await timeMs("dbWrite", () => linkRepository.update(link.id, { final_url: finalUrl, eligibility_url: eligibilityUrl, page_title: extractedPage.page_title, http_status: res.status ?? undefined, status: classification.status, page_class: finalClass.pageClass, content_verified: validatedInline, evidence: validation.evidence || validation.reasons[0] || null, screenshot_path: null, html_path: htmlPath, text_path: textPath }));
      await logAction({
        university_id: university.id,
        discovered_link_id: link.id,
        action: CrawlAction.VALIDATE_LINK,
        status: "OK",
        message: `${classification.status} (${classification.reason}) · ${finalClass.pageClass} · ${validation.outcome}${validatedInline ? ` ✓ ${validation.targetType}${eligibilityUrl ? ` (anchor: ${eligibilityUrl})` : ""}` : ` — ${validation.reasons[0] ?? ""}`} [fast-lane]`,
      });

      // Validated COURSE target → clean + chunk + snapshot + enqueue parse INLINE
      // (same finalisation the browser lane does, minus the screenshot/raw-html).
      if (validatedInline && context === CrawlContext.ELIGIBILITY && validation.targetType === "COURSE") {
        const cleanChunkT = Date.now();
        const nSections = await finalizeCourseTarget({ linkId: link.id, requestUrl: r.url, finalUrl, urlHash, extracted: extractedPage, sourceLanguage: classification.source_language, htmlPath, screenshotPath: null });
        await logAction({ university_id: university.id, discovered_link_id: link.id, action: CrawlAction.CHUNK_CONTENT, status: "OK", message: `${nSections} sections chunked [fast-lane]` });
        ms.cleanChunk += Date.now() - cleanChunkT;
      }

      // DISCOVERY (same gates as the browser lane, feeding the FAST queue).
      const depth = ud.depth ?? 0;
      if (depth >= env.MAX_CRAWL_DEPTH) {
        if (++pagesSinceRecount >= 40) await flushCounters();
        return;
      }
      const newRows: Parameters<typeof linkRepository.createManyDiscovered>[0] = [];
      const rejectedSamples: string[] = [];
      const considerChildFast = (url: string, text: string) => {
        const childHash = hashUrl(url);
        if (seenHashes.has(childHash)) return;
        if (skipOldEdition(url)) return;
        seenHashes.add(childHash);
        const gate = gateUrl({ url, anchorText: text, parentUrl: finalUrl }, context);
        if (!gate.decision.allowed) {
          if (gate.decision.crossContext) {
            rejectCrossContext(newRows, url, text, depth + 1, gate);
            if (rejectedSamples.length < 3) rejectedSamples.push(`${url} [${gate.classification.pageClass}]`);
          }
          return;
        }
        const { score } = scoreLink({ url, anchorText: text, baseUrl: university.base_url, context });
        const disposition = dispositionFor(score, env.MIN_LINK_SCORE);
        if (disposition === "SKIP") return;
        if (env.PRUNE_DEAD_BRANCHES && disposition === "DISCOVER_ONLY" && branchYield.isDead(url)) {
          branchesPruned += 1;
          return;
        }
        // CATALOG-DRIVEN SCOPE: a generic low-value page that isn't a target
        // candidate, target listing, or course-section hub is not followed AND
        // not recorded — the sitemap + catalogue already enumerate the
        // deliverable, so crawling it would only burn time and bloat the link
        // count (the 30:1 waste fix). Treated exactly like a SKIP disposition.
        if (!shouldFetchForDiscovery({ url, pageClass: gate.classification.pageClass, disposition, depth: depth + 1, catalogDriven: env.CATALOG_DRIVEN_CRAWL })) {
          scopeSkipped += 1;
          return;
        }
        result.urlsAuthorized += 1;
        newRows.push({ university_id: university.id, url, url_hash: childHash, canonical_url: canonicalizeUrl(url), link_text: text, link_score: score, depth: depth + 1, status: disposition === "EXTRACT" ? LinkStatus.QUEUED : LinkStatus.LOW_CONFIDENCE_PAGE, crawl_context: context, page_class: gate.classification.pageClass });
        pushTiered({ url, userData: { depth: depth + 1, linkScore: score, linkText: text, context, pageClass: gate.classification.pageClass, parentUrl: finalUrl } });
      };
      for (const l of extractedPage.internal_links) yearGate.observe(l.url);
      for (const u2 of finderJsonUrls) yearGate.observe(u2);
      for (const { url, text } of extractedPage.internal_links) {
        if (!isSameDomain(url, university.base_url)) continue;
        if (isResume && isDone(url)) continue;
        const f = filterLink(url);
        if (f.rejected && !f.isPdf) continue;
        if (f.isPdf) {
          const pdfHash = hashUrl(url);
          if (seenHashes.has(pdfHash)) continue;
          seenHashes.add(pdfHash);
          newRows.push({ university_id: university.id, url, url_hash: pdfHash, canonical_url: canonicalizeUrl(url), link_text: text, link_score: 0, depth: depth + 1, status: LinkStatus.PDF_DEFERRED, crawl_context: context, page_class: PageClass.DOCUMENT });
          const htmlPage = htmlPageFromPdf(url);
          if (htmlPage && isSameDomain(htmlPage, university.base_url) && !(isResume && isDone(htmlPage))) considerChildFast(htmlPage, text);
          continue;
        }
        considerChildFast(url, text);
      }
      for (const u2 of finderJsonUrls) {
        if (!isSameDomain(u2, university.base_url)) continue;
        if (isResume && isDone(u2)) continue;
        if (filterLink(u2).rejected) continue;
        considerChildFast(u2, "");
      }
      if (newRows.length) result.linksFound += await timeMs("dbWrite", () => linkRepository.createManyDiscovered(newRows));
      if (rejectedSamples.length) {
        await logAction({ university_id: university.id, discovered_link_id: link.id, action: CrawlAction.DISCOVER_LINKS, status: "OK", message: `fetch-rejected(cross-context): ${rejectedSamples.length}+ URL(s) blocked BEFORE fetch in ${context} crawl — e.g. ${rejectedSamples.join(" · ")}` }).catch(() => {});
      }
      if (++pagesSinceRecount >= 40) await flushCounters();
    };

    // PERIODIC IN-CRAWL COVERAGE RECOVERY: a page blocked by a TRANSIENT
    // bot-challenge earlier in THIS crawl becomes fetchable again the moment
    // the host clears — but the start-of-crawl recovery pass can't see blocks
    // that accumulate AFTER it ran, so on a long crawl those pages would sit
    // BLOCKED for hours (observed live: 499 CSU course pages fetchable at 200/
    // 1MB yet frozen BLOCKED). This re-probes blocked hosts every few minutes
    // with a REAL page GET (robots.txt is unreliable — CSU 403s it by policy
    // while serving content fine) and folds every recovered page back into the
    // live fast-lane queue at top priority. Bounded by MAX_RECOVERIES so a
    // persistently-flapping host can't loop the crawl forever.
    let done = false;
    let inFlight = 0;
    const idle = () => qTop.length + qMid.length + qLow.length === 0 && inFlight === 0;

    const recoverBlockedIntoQueue = async (): Promise<number> => {
      let added = 0;
      try {
        const blocked = await prisma.discoveredLink.findMany({
          where: { university_id: university.id, crawl_context: context, status: "BLOCKED" },
          select: { id: true, url: true },
        });
        if (!blocked.length) return 0;
        const byHost = new Map<string, { ids: string[]; urls: string[] }>();
        for (const b of blocked) {
          try {
            const h = new URL(b.url).hostname;
            const e = byHost.get(h) ?? { ids: [], urls: [] };
            e.ids.push(b.id);
            e.urls.push(b.url);
            byHost.set(h, e);
          } catch { /* malformed — leave blocked */ }
        }
        for (const [host, e] of byHost) {
          // Probe an ACTUAL blocked page: 2xx/3xx + not-a-challenge = recovered.
          const res = await httpFetchPage(e.urls[0]!, SITEMAP_HEADERS, 12000);
          const okStatus = (res.status ?? 0) >= 200 && (res.status ?? 0) < 400;
          if (!res.ok || !okStatus || looksLikeBotChallenge(res.body.slice(0, 8000))) continue;
          await prisma.discoveredLink
            .updateMany({ where: { id: { in: e.ids } }, data: { status: "QUEUED", http_status: null, content_verified: false, error_message: null } })
            .catch(() => {});
          for (const u of e.urls) {
            seenHashes.delete(hashUrl(u));
            escalatedSeen.delete(u);
            pushTiered({ url: u, userData: { depth: 1, linkScore: 60, linkText: "(recovered)", context, pageClass: classifyUrl({ url: u }).pageClass } });
            added += 1;
          }
          await logAction({ university_id: university.id, action: CrawlAction.DISCOVER_LINKS, status: "OK", message: `coverage recovery (in-crawl): ${host} cleared — re-queued ${e.urls.length} previously blocked page(s) into the fast lane` }).catch(() => {});
        }
      } catch { /* recovery is best-effort — never fail the crawl */ }
      return added;
    };

    const worker = async () => {
      for (;;) {
        if (done) return; // budget/coordinator stop — leave remaining rows QUEUED for resume
        const r = pop();
        if (!r) {
          if (done) return;
          await sleep(250); // park briefly; recovery may fold more work back in
          continue;
        }
        inFlight += 1;
        try {
          await handleFast(r);
        } catch {
          escalate(r, "network"); // any unexpected fast-lane error → browser owns it
        } finally {
          inFlight -= 1;
        }
      }
    };

    const RECOVERY_INTERVAL_MS = 3 * 60_000;
    const MAX_RECOVERIES = 40; // global safety bound over the whole crawl
    let recoveryRuns = 0;
    let lastRecoveryAt = Date.now();
    const coordinator = async () => {
      for (;;) {
        // Poll cheaply and often (idle() is an in-memory length check — no I/O)
        // so a drained frontier is detected in ~2s, not 20s. The old 20s poll
        // added a flat tail to EVERY university's completion — with a low
        // CRAWL_CONCURRENCY, that tail held the worker slot the NEXT queued
        // university needed, so "resume/discover immediately" visibly lagged.
        // Real recovery-probe pacing is still governed by RECOVERY_INTERVAL_MS
        // / MAX_RECOVERIES below — this only speeds up noticing "nothing left".
        await sleep(2_000);
        if (done) return;
        if (idle()) {
          // Frontier drained. Give up if we've exhausted the recovery budget;
          // otherwise one more recovery pass, and finish when it yields nothing.
          if (recoveryRuns >= MAX_RECOVERIES) { done = true; return; }
          recoveryRuns += 1;
          lastRecoveryAt = Date.now();
          if ((await recoverBlockedIntoQueue()) === 0) { done = true; return; }
        } else if (recoveryRuns < MAX_RECOVERIES && Date.now() - lastRecoveryAt >= RECOVERY_INTERVAL_MS) {
          // Still crawling — opportunistically fold any cleared hosts back in.
          recoveryRuns += 1;
          lastRecoveryAt = Date.now();
          await recoverBlockedIntoQueue();
        }
      }
    };

    await Promise.all([coordinator(), ...Array.from({ length: FAST_CONCURRENCY }, () => worker())]);
  };

  // NO hard time cap: the crawl runs to FRONTIER CLOSURE (every queued page
  // visited). Runaway growth is bounded deterministically by link filters, the
  // score gate, and MAX_PAGES_PER_UNIVERSITY — not by a clock — so an unchanged
  // site always yields the same page set no matter how slow the network is today.
  try {
    const initialRequests: FastReq[] = [rootRequest, ...seeds.map((s) => ({ url: s.url, userData: s.userData }))];
    if (env.HTTP_FIRST_FETCH) {
      await runFastLane(initialRequests);
      if (escalatedRequests.length || fastBlockedCount) {
        await logAction({ university_id: university.id, action: CrawlAction.DISCOVER_LINKS, status: "OK", message: `fast lane done — ${n.httpFetch} HTTP fetches; ${scopeSkipped} off-catalogue link(s) skipped (not fetched — sitemap/catalogue already covers the deliverable); ${branchesPruned} pruned; ${fastBlockedCount} bot-blocked page(s) recorded BLOCKED (fast-lane recovers later); ${escalatedRequests.length} escalated to the browser (network=${esc.network} challenge=${esc.challenge} blocked=${esc.blocked} thin=${esc.thin} finder=${esc.finder} validatedTargets=${esc.validated})` }).catch(() => {});
      }
      if (escalatedRequests.length) {
        await crawler.run(escalatedRequests.map((r2) => ({ url: r2.url, userData: r2.userData })));
      }
    } else {
      await crawler.run(initialRequests.map((r2) => ({ url: r2.url, userData: r2.userData })));
    }
  } catch (err) {
    // A late page error after the pool winds down must NOT fail the whole job —
    // we keep everything crawled so far. Genuine per-page failures are already
    // logged in failedRequestHandler.
    logger.warn({ universityId: university.id, err: String(err) }, "crawl run ended early");
  }

  // Final authoritative recompute of the headline counters from the real tables.
  await flushCounters();

  // COMPLETION TRUTH-CHECK: count the crawlable pages still pending for THIS
  // context, straight from the DB. This is what decides COMPLETED vs STOPPED in
  // the worker — never an in-memory guess (which is how "completed 100%" could
  // show while thousands of rows sat unvisited). Covers both lanes: the fast
  // lane's budget stop AND Crawlee's maxRequestsPerCrawl cut-off leave rows
  // QUEUED/LOW_CONFIDENCE_PAGE with no http_status.
  try {
    result.pendingRemaining = await prisma.discoveredLink.count({
      where: {
        university_id: university.id,
        crawl_context: context,
        http_status: null,
        status: { in: ["QUEUED", "LOW_CONFIDENCE_PAGE"] },
      },
    });
  } catch { /* count is bookkeeping — a transient DB error must not fail the crawl */ }
  if (!result.stoppedAtBudget && result.pagesVisited >= env.MAX_PAGES_PER_UNIVERSITY) {
    result.stoppedAtBudget = true; // browser-lane cap (Crawlee maxRequestsPerCrawl)
  }

  // PERF SUMMARY (redesign Step 1) — per-context breakdown of where the wall
  // time actually went, so the NEXT optimization is chosen from data, not a
  // guess. Totals are cumulative handler time; per-page averages (/pg) are the
  // robust figures. "~fixedDelay" is the same-domain politeness delay incurred
  // (pwNavs × CRAWL_DELAY_MS) — it's enforced inside Crawlee, not timed here, so
  // it's computed. HTTP fetches are 0 today (every page is a Playwright nav);
  // that zero is itself the finding that motivates the HTTP-first step.
  const totalMs = Date.now() - crawlStartedAt;
  const pg = n.pwNav || 1; // avoid /0 when a resume crawls no new pages
  const s = (x: number) => (x / 1000).toFixed(1);
  const perPg = (x: number) => (x / pg).toFixed(0);
  const fixedDelayMs = n.pwNav * env.CRAWL_DELAY_MS;
  const perf = {
    context,
    totalMs,
    httpFetches: n.httpFetch,
    pwNavs: n.pwNav,
    escalations: esc,
    deadPages: n.dead,
    finderPages: n.finder,
    screenshots: n.screenshot,
    duplicateAliases: n.dup,
    yearEditionsSkipped,
    branchesPruned,
    adaptiveThrottle: adaptive,
    throttleDelayMsFinal: throttle.delayMs,
    fixedDelayMsEstimate: adaptive ? 0 : fixedDelayMs,
    stageMs: ms,
  };
  logger.info({ universityId: university.id, ...perf }, "crawl perf summary");
  // With adaptive throttle ON, there is no per-page fixed sleep; report the
  // throttle's final backoff instead (0 = the server stayed healthy throughout).
  const delayLine = adaptive
    ? `throttleDelayFinal=${throttle.delayMs}ms(adaptive)`
    : `~fixedDelay=${s(fixedDelayMs)}s(pwNavs×${env.CRAWL_DELAY_MS}ms)`;
  await logAction({
    university_id: university.id,
    action: CrawlAction.DISCOVER_LINKS,
    status: "OK",
    duration_ms: totalMs,
    message:
      `PERF[${context}] total=${s(totalMs)}s pages=${result.pagesVisited} httpFetches=${n.httpFetch} pwNavs=${n.pwNav} escalated(net=${esc.network},chal=${esc.challenge},blk=${esc.blocked},thin=${esc.thin},finder=${esc.finder},valid=${esc.validated}) dead=${n.dead} pruned=${branchesPruned} yearDup=${yearEditionsSkipped} aliasDup=${n.dup} | ` +
      `settle=${s(ms.settle)}s(${perPg(ms.settle)}ms/pg) ` +
      `finder=${s(ms.finder)}s(${n.finder}p) ` +
      `extract=${s(ms.extract)}s(${perPg(ms.extract)}ms/pg) ` +
      `screenshot=${s(ms.screenshot)}s(${n.screenshot} shots, ${perPg(ms.screenshot)}ms/pg) ` +
      `validate=${s(ms.validate)}s ` +
      `cleanChunk=${s(ms.cleanChunk)}s(${result.snapshots} targets) ` +
      `dbWrite=${s(ms.dbWrite)}s(${perPg(ms.dbWrite)}ms/pg) ` +
      `discovery=${s(ms.sitemap)}s | ${delayLine}`,
  }).catch(() => {});

  // Observability (spec: performance requirement): discovered / authorized /
  // cross-context-rejected / fetched / validated — rejected URLs cost 0 fetches.
  await logAction({
    university_id: university.id,
    action: CrawlAction.DISCOVER_LINKS,
    status: "OK",
    message: `Crawl finished (${context}) — discovered=${result.linksFound} authorized=${result.urlsAuthorized} crossContextRejected=${result.crossContextRejected} (0 network requests each) fetched=${result.pagesVisited} validatedTargets=${result.validatedTargets} discoveryOnly=${result.discoveryOnlyPages}`,
  }).catch(() => {});

  return result;
}
