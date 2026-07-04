import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { PlaywrightCrawler, Configuration, type PlaywrightCrawlingContext } from "crawlee";
import { chromium, type BrowserContext } from "playwright";
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
  type University,
} from "@clg/database";
import { enqueueParse } from "@clg/queue";
import { filterLink } from "../discovery/linkFilters.js";
import { scoreLink, dispositionFor } from "../discovery/linkScorer.js";
import { gateUrl, authorizeFetch, CROSS_CONTEXT_FETCH_BLOCKED, type GateResult } from "../discovery/crawlAuthorization.js";
import { classifyUrl } from "../discovery/urlClassifier.js";
import { extractPage } from "../extraction/extractPage.js";
import { extractCourseFacts, type CourseFacts } from "../extraction/courseFacts.js";
import { deepLinkEligibility, entryRequirementAnchor } from "../extraction/eligibilityAnchor.js";
import { captureScreenshot } from "../extraction/screenshot.js";
import { classifyPage, isParseablePage } from "../validation/validatePage.js";
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
 * Read sitemap.xml (+ robots.txt sitemaps + nested sitemap indexes) to capture the
 * FULL URL inventory of a site — course-finder results, A-Z lists and programme
 * pages that breadth-first clicking often misses. Fetched through a real browser so
 * bot-protected course catalogs (e.g. study.<uni>) are actually retrieved.
 */
async function discoverSitemapUrls(baseUrl: string, cap = 20000): Promise<string[]> {
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

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const ctx = await browser.newContext({ userAgent: SITEMAP_HEADERS["user-agent"] });
    // robots.txt sitemaps for the base + the common course-catalog subdomains.
    for (const o of new Set([base.origin, `https://study.${reg}`, `https://courses.${reg}`, `https://handbook.${reg}`])) {
      const robots = await browserGet(ctx, `${o}/robots.txt`, 8000);
      for (const m of robots.matchAll(/sitemap:\s*(\S+)/gi)) queue.push(m[1]!.trim());
    }
    let fetched = 0;
    while (queue.length && fetched < 80 && out.size < cap) {
      const sm = queue.shift()!;
      if (seen.has(sm)) continue;
      seen.add(sm);
      fetched += 1;
      const xml = await browserGet(ctx, sm, 20000);
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
    await ctx.close();
  } catch {
    /* sitemap discovery is best-effort */
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return [...out];
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
  };
  const seenHashes = new Set<string>();

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

  // COURSE FACTS (redesign §11): tuition fees / intakes / duration / deadline /
  // mode / campus / CRICOS / English requirement / benefits / eligibility snippet,
  // extracted INLINE from text we already hold (zero extra fetches, O(text)/page).
  // Persisted per university; Revalidate joins them into the course export columns.
  const factsPath = join(repoRoot(), "storage", "state", "facts", `${university.id}.json`);
  let courseFacts: Record<string, { url: string } & CourseFacts> = {};
  try {
    if (existsSync(factsPath)) courseFacts = JSON.parse(readFileSync(factsPath, "utf8"));
  } catch { /* corrupt facts state = start fresh */ }
  const flushFacts = () => {
    try {
      mkdirSync(dirname(factsPath), { recursive: true });
      let onDisk: typeof courseFacts = {};
      try { if (existsSync(factsPath)) onDisk = JSON.parse(readFileSync(factsPath, "utf8")); } catch { /* ignore */ }
      const merged = { ...onDisk, ...courseFacts }; // crawl-time facts win per key (freshest)
      writeFileSync(`${factsPath}.tmp`, JSON.stringify(merged), "utf8");
      renameSync(`${factsPath}.tmp`, factsPath);
    } catch { /* facts are additive — never fail the crawl */ }
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
    flushFacts();
    await universityRepository.recomputeStats(university.id).catch(() => {});
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
  const { done: doneUrls, pending: pendingFrontier } = await linkRepository.resumeState(university.id, context);
  const isResume = doneUrls.size > 0;
  const isDone = (u: string) => doneUrls.has(u) || doneUrls.has(canonicalizeUrl(u));

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
      // Ethical crawling (Section 19): obey robots.txt + a same-domain delay.
      // Fractional seconds (no ceil) so a sub-second delay actually means e.g.
      // 0.4s — not rounded up to a full second — which roughly halves per-page
      // time and lets far more pages fit inside the time budget.
      respectRobotsTxtFile: true,
      sameDomainDelaySecs: env.CRAWL_DELAY_MS / 1000,
      // ROOT-CAUSE FIX for the recurring 0xC0000409 crash: headless Chromium
      // leaks memory across a long crawl until the process dies hard. Retire +
      // relaunch the browser every 15 pages to keep memory flat.
      browserPoolOptions: { retireBrowserAfterPageCount: 15 },
      launchContext: {
        launchOptions: {
          args: [
            "--no-sandbox",
            "--disable-dev-shm-usage", // don't use limited /dev/shm for shared memory
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-renderer-backgrounding",
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

        // FAST settle: wait until the DOM is QUIET (no mutations for 250ms) instead
        // of a fixed sleep — static pages proceed in ~250ms (was a flat 600ms on
        // every page, pure dead time at scale), while JS-driven pages get up to
        // 1.5s to finish rendering their links. Deterministic: the wait ends on a
        // provable condition (DOM stability), not on a guess.
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

        // Does this page have a dynamic course/program list worth extra effort?
        const isFinder = await page
          .evaluate(() => {
            if (document.querySelector('table tbody tr, select[name$="_length"], .dataTables_length, [class*="datatable" i], [class*="finder" i]')) return true;
            return /load more|show more|view all|see all|more courses|load all/i.test((document.body && document.body.innerText) || "");
          })
          .catch(() => false);

        if (isFinder) {
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
        }

        const httpStatus = response?.status() ?? null;
        const extracted = await extractPage(page, request.url);
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
        const screenshotPath = await captureScreenshot(page, university.id, urlHash, storage).catch(() => null);
        const htmlPath = keepArtifacts ? await storage.saveText(storagePaths.html(university.id, urlHash), extracted.raw_html) : null;
        const textPath = keepArtifacts ? await storage.saveText(storagePaths.text(university.id, urlHash), extracted.visible_text) : null;

        // Update the discovered-link row for this final URL.
        const link = await linkRepository.upsert({
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
        });
        // ENTRY-REQUIREMENTS ANCHOR (eligibility crawls only): from the HTML we
        // already have, find the anchor of this page's entry-requirements section/
        // tab/modal. The anchor is SUPPORTING METADATA — it never creates another
        // crawl target, never triggers another fetch, and never replaces the main
        // course URL: the primary/exported URL stays the main course page.
        const anchor = context === CrawlContext.ELIGIBILITY && keepArtifacts ? entryRequirementAnchor(extracted.raw_html) : null;

        // COURSE FACTS (eligibility crawls): course/admission-shaped pages get the
        // facts ladder run on the text we already extracted — fees, intakes, ….
        let factCount = 0;
        if (context === CrawlContext.ELIGIBILITY && keepArtifacts) {
          const facts = extractCourseFacts(extracted.visible_text, extracted.raw_html);
          factCount = Object.keys(facts).length;
          if (factCount) {
            courseFacts[canonicalizeUrl(finalUrl)] = { url: stripTrackingParams(finalUrl), ...facts };
          }
        }

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
        const validation = validateTarget({
          context,
          finalUrl,
          pageClass: finalClass.pageClass,
          title: extracted.page_title,
          text: extracted.visible_text,
          hasEntryAnchor: !!anchor,
          factCount,
        });
        const contentVerified = validation.outcome === TargetOutcome.VALIDATED_TARGET;
        if (contentVerified) result.validatedTargets += 1;
        else if (validation.outcome === TargetOutcome.DISCOVERY_ONLY) result.discoveryOnlyPages += 1;

        // The anchor deep-link ships ONLY as secondary metadata of a validated
        // COURSE target (tracking params stripped so one course can't appear
        // twice under different campaign junk). Primary URL = main course page.
        const eligibilityUrl =
          contentVerified && validation.targetType === "COURSE" && anchor
            ? deepLinkEligibility(stripTrackingParams(finalUrl), extracted.raw_html)
            : null;

        await linkRepository.update(link.id, {
          final_url: finalUrl,
          eligibility_url: eligibilityUrl,
          page_title: extracted.page_title,
          http_status: httpStatus ?? undefined,
          status: classification.status,
          page_class: finalClass.pageClass,
          content_verified: contentVerified,
          evidence: validation.evidence || validation.reasons[0] || null,
          screenshot_path: screenshotPath,
          html_path: htmlPath,
          text_path: textPath,
        });

        await logAction({
          university_id: university.id,
          discovered_link_id: link.id,
          action: CrawlAction.VALIDATE_LINK,
          status: "OK",
          message: `${classification.status} (${classification.reason}) · ${finalClass.pageClass} · ${validation.outcome}${
            contentVerified
              ? ` ✓ ${validation.targetType}${eligibilityUrl ? ` (anchor: ${eligibilityUrl})` : ""}`
              : ` — ${validation.reasons[0] ?? ""}`
          }`,
        });

        // Clean + chunk + enqueue parse ONLY for validated individual course
        // targets of an ELIGIBILITY crawl — the course-criteria parser must never
        // receive general admissions/eligibility pages, listings or scholarship
        // pages (those stay discovery surfaces, not parse inputs).
        if (context === CrawlContext.ELIGIBILITY && contentVerified && validation.targetType === "COURSE") {
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
          await flushCounters(); // valid pages are infrequent — reflect each one live

          await snapshotRepository.findById(snapshot.id); // touch (no-op safety)
          await enqueueParse({ universityId: university.id, snapshotId: snapshot.id, crawlJobId, context });
          await logAction({
            university_id: university.id,
            discovered_link_id: link.id,
            action: CrawlAction.CHUNK_CONTENT,
            status: "OK",
            message: `${sections.length} sections chunked`,
          });
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
        if (newRows.length) result.linksFound += await linkRepository.createManyDiscovered(newRows);
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
      const smUrls = await discoverSitemapUrls(university.base_url);
      const smRows: Parameters<typeof linkRepository.createManyDiscovered>[0] = [];
      let seeded = 0;
      let smRejected = 0;
      for (const url of smUrls) {
        if (!isSameDomain(url, university.base_url)) continue;
        const f = filterLink(url);
        const urlHash = hashUrl(url);
        if (seenHashes.has(urlHash)) continue;
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

  // RESUME: re-seed the pending frontier (links discovered but not yet visited
  // last time) so the crawl continues from where it stopped. Every recovered URL
  // re-passes classification + authorization: old rows queued before a policy
  // change (or by another producer) can never smuggle a cross-context page past
  // the gate — recovery obeys the same rules as fresh discovery.
  if (isResume) {
    let resumeRejected = 0;
    for (const p of pendingFrontier) {
      if (isDone(p.url)) continue;
      // Filters evolve between runs (e.g. subject/unit pages are now hard-rejected):
      // never re-queue a pending URL the CURRENT filters would reject — this is what
      // stops a resumed crawl from burning hours on thousands of stale frontier rows.
      if (filterLink(p.url).rejected) continue;
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
      result.urlsAuthorized += 1;
      seeds.push({ url: p.url, userData: { depth: 1, linkScore: p.score, linkText: "(resumed)", context, pageClass: gate.classification.pageClass } });
    }
    await logAction({
      university_id: university.id,
      action: CrawlAction.DISCOVER_LINKS,
      status: "OK",
      message: `Resuming ${context} crawl — ${doneUrls.size} pages already done, ${pendingFrontier.length} pending to continue${resumeRejected ? `, ${resumeRejected} stale frontier URL(s) blocked as cross-context before fetch` : ""}.`,
    });
  }

  // NO hard time cap: the crawl runs to FRONTIER CLOSURE (every queued page
  // visited). Runaway growth is bounded deterministically by link filters, the
  // score gate, and MAX_PAGES_PER_UNIVERSITY — not by a clock — so an unchanged
  // site always yields the same page set no matter how slow the network is today.
  try {
    await crawler.run([
      // The crawl ROOT is the user-provided university homepage — always
      // fetchable (navigation) in either context; children are gated normally.
      { url: university.base_url, userData: { depth: 0, linkScore: 100, linkText: university.name, context, pageClass: PageClass.NAVIGATION_PAGE } satisfies CrawlUserData },
      ...seeds.map((s) => ({ url: s.url, userData: s.userData })),
    ]);
  } catch (err) {
    // A late page error after the pool winds down must NOT fail the whole job —
    // we keep everything crawled so far. Genuine per-page failures are already
    // logged in failedRequestHandler.
    logger.warn({ universityId: university.id, err: String(err) }, "crawl run ended early");
  }

  // Final authoritative recompute of the headline counters from the real tables.
  await flushCounters();

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
