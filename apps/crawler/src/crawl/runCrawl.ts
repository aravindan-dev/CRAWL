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
  humanizeError,
  getKeywords,
  keywordsToRegex,
  htmlPageFromPdf,
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
import { extractPage } from "../extraction/extractPage.js";
import { deepLinkEligibility, entryRequirementAnchor } from "../extraction/eligibilityAnchor.js";
import { captureScreenshot } from "../extraction/screenshot.js";
import { classifyPage, isParseablePage } from "../validation/validatePage.js";
import { cleanContent } from "../cleaning/contentCleaner.js";
import { chunkSections } from "../chunking/sectionChunker.js";
import { logAction } from "../observability/log.js";

const storage = new LocalStorageProvider();

// --- INLINE content-validation (single-pass "crawl & validate") ---------------
// The crawl already has the page TEXT in hand, so confirming a page genuinely
// contains entry-requirement (eligibility) / scholarship evidence — not just a
// keyword in the URL — is essentially free (a regex over already-extracted text,
// no second fetch). This is what turns the old two-pass flow (crawl, then
// verify-eligibility over the whole corpus) into ONE per-URL pass: crawl a URL →
// validate it → it appears live in the "Validated URLs" feed → crawl the next.
const KW = getKeywords();
const EVIDENCE_RE = keywordsToRegex(KW.evidence); // page-content proof of entry requirements
const SCHOLARSHIP_RE = keywordsToRegex(KW.scholarship); // funding/scholarship signals

/** Short proof snippet around the first evidence match (shown in the feed / Logs). */
function evidenceSnippet(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m || m.index === undefined) return "";
  return text.slice(Math.max(0, m.index - 50), m.index + 90).replace(/\s+/g, " ").trim();
}

/**
 * Validate a freshly-crawled page INLINE against the configured CRAWL_TARGET.
 * Eligibility: a parseable (course/admission/requirement) page whose TEXT proves
 * entry-requirement content. Scholarship: a page whose URL/title is about funding
 * AND whose text confirms it. Returns the verdict + a proof snippet — cheap.
 */
function validateContent(opts: { text: string; parseable: boolean; url: string; title: string }): {
  verified: boolean;
  snippet: string;
  kind: "eligibility" | "scholarship" | null;
} {
  const { text } = opts;
  if (!text) return { verified: false, snippet: "", kind: null };
  const target = env.CRAWL_TARGET; // "both" | "eligibility" | "scholarship"
  const wantElig = target !== "scholarship";
  const wantSch = target !== "eligibility";
  if (wantElig && opts.parseable && EVIDENCE_RE.test(text)) {
    return { verified: true, snippet: evidenceSnippet(text, EVIDENCE_RE), kind: "eligibility" };
  }
  if (wantSch && SCHOLARSHIP_RE.test(`${opts.url} ${opts.title}`) && SCHOLARSHIP_RE.test(text)) {
    return { verified: true, snippet: evidenceSnippet(text, SCHOLARSHIP_RE), kind: "scholarship" };
  }
  return { verified: false, snippet: "", kind: null };
}

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
}

export interface CrawlResult {
  linksFound: number;
  validLinks: number;
  snapshots: number;
  pagesVisited: number;
}

/**
 * Crawl one university end-to-end: discover → score → validate → extract →
 * clean → chunk → enqueue parse. Uses an isolated in-memory Crawlee
 * Configuration per job so concurrent university crawls don't share storage.
 */
export async function runUniversityCrawl(
  university: University,
  crawlJobId: string,
): Promise<CrawlResult> {
  const result: CrawlResult = { linksFound: 0, validLinks: 0, snapshots: 0, pagesVisited: 0 };
  const seenHashes = new Set<string>();

  // LIVE counters: RECOMPUTE the headline counters from the real tables so the
  // dashboard's Links / Valid / Courses are always authoritative and can never
  // drift (the old per-event increments double-counted across resumes, giving
  // nonsense like valid > links). Recompute is debounced (not per page) so it
  // stays cheap while still ticking up live during the crawl.
  let pagesSinceRecount = 0;
  const flushCounters = async () => {
    pagesSinceRecount = 0;
    await universityRepository.recomputeStats(university.id).catch(() => {});
  };

  // Per-university wall-clock budget. High-value (eligibility/course/admission)
  // links are enqueued FIRST (forefront), so when this is reached we've already
  // captured what matters. This is what bounds each university to ~the budget, so
  // N universities crawled in parallel all finish within ~the budget (not N×).
  const deadline = env.MAX_CRAWL_MINUTES > 0 ? Date.now() + env.MAX_CRAWL_MINUTES * 60_000 : Infinity;
  let budgetHit = false;

  // RESUME: pages already visited in a previous (stopped/crashed) run are skipped,
  // and the still-pending frontier is re-seeded — so a crawl continues exactly
  // where it left off instead of starting over. DB-driven → survives restarts.
  const { done: doneUrls, pending: pendingFrontier } = await linkRepository.resumeState(university.id);
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
    });
    result.linksFound += 1;
  };

  const crawler = new PlaywrightCrawler(
    {
      maxConcurrency: env.PER_DOMAIN_CONCURRENCY,
      maxRequestsPerCrawl: env.MAX_PAGES_PER_UNIVERSITY,
      // Reasonable per-page budgets: real sites respond in ~1–3s, so 30s is
      // plenty (and dead/slow pages fail fast instead of wasting 60s each).
      navigationTimeoutSecs: 30,
      requestHandlerTimeoutSecs: 90,
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

        // TIME BUDGET: once the per-university wall-clock budget is reached, stop
        // pulling new pages and wind the crawl down. High-value links were crawled
        // first, so we already have the eligibility/course pages that matter.
        if (Date.now() > deadline) {
          if (!budgetHit) {
            budgetHit = true;
            await logAction({ university_id: university.id, action: CrawlAction.DISCOVER_LINKS, status: "OK", message: `Time budget (${env.MAX_CRAWL_MINUTES} min) reached — wrapping up with the high-value pages already crawled.` }).catch(() => {});
          }
          await ctx.crawler.autoscaledPool?.abort().catch(() => {});
          return;
        }

        // RESUME: this page was already crawled in a previous run — skip the
        // expensive re-extraction so we continue where we left off.
        if (isResume && isDone(request.url)) return;
        result.pagesVisited += 1;

        // FAST settle: most pages have their links in the HTML at DOM-ready, so a
        // short fixed wait is enough — NO per-page networkidle (that 3.5s wait was
        // the main bottleneck). networkidle is reserved for finder/table pages
        // below that genuinely fetch rows via AJAX.
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(600);

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
        }

        const httpStatus = response?.status() ?? null;
        const extracted = await extractPage(page, request.url);
        const finalUrl = extracted.final_url;
        const urlHash = hashUrl(finalUrl);

        const classification = classifyPage({ httpStatus, requestedUrl: request.url, page: extracted });

        // Every VISITED page becomes a discovered-link row shown in "Review links",
        // so capture a screenshot for ALL of them — including low-score / low-
        // confidence pages — because reviewers need to see the page to judge it.
        // The heavy raw HTML + extracted text are kept only for parseable
        // (course / admission / requirement) pages; use the dashboard's Storage
        // cleanup to reclaim space after exporting.
        const keepArtifacts = isParseablePage(classification.status);
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
        });
        // INLINE VALIDATE (single pass): confirm the page's TEXT actually proves
        // entry-requirement / scholarship content right now, while it's open — so a
        // validated URL can stream straight into the live "Validated URLs" feed.
        const validated = validateContent({
          text: extracted.visible_text,
          parseable: keepArtifacts,
          url: finalUrl,
          title: extracted.page_title,
        });

        // ENTRY-REQUIREMENTS DEEP-LINK (live): from the HTML we already have, find
        // the anchor of this page's entry-requirements section/tab/modal and build
        // the exact eligibility URL (e.g. …/course/MGM102/2/2026#academicentry-
        // requirementsmodal). It is shown LIVE in the Validated feed and reused by
        // the export — so the link you watch during the crawl IS the delivered link.
        // A page that HAS such a section proves it carries entry-requirement content
        // even when those load in a MODAL (so the body text alone didn't trip the
        // evidence check) — so we also count it validated, which is what surfaces
        // EVERY course in the live feed, not just the few whose inline text matched.
        const wantElig = env.CRAWL_TARGET !== "scholarship";
        const anchor = keepArtifacts ? entryRequirementAnchor(extracted.raw_html) : null;
        const eligibilityUrl = anchor ? deepLinkEligibility(finalUrl, extracted.raw_html) : null;
        const verifiedByAnchor = !validated.verified && wantElig && !!anchor;
        const contentVerified = validated.verified || verifiedByAnchor;
        const evidence = validated.snippet || (verifiedByAnchor ? `entry-requirements section (#${anchor})` : "");

        await linkRepository.update(link.id, {
          final_url: finalUrl,
          eligibility_url: eligibilityUrl,
          page_title: extracted.page_title,
          http_status: httpStatus ?? undefined,
          status: classification.status,
          content_verified: contentVerified,
          evidence: evidence || null,
          screenshot_path: screenshotPath,
          html_path: htmlPath,
          text_path: textPath,
        });

        await logAction({
          university_id: university.id,
          discovered_link_id: link.id,
          action: CrawlAction.VALIDATE_LINK,
          status: "OK",
          message: `${classification.status} (${classification.reason})${
            contentVerified
              ? ` · validated ✓ ${validated.kind ?? "eligibility"}${eligibilityUrl ? ` → ${eligibilityUrl}` : ""}`
              : keepArtifacts
                ? " · no entry-requirement evidence in text"
                : ""
          }`,
        });

        // Clean + chunk + enqueue parse for parseable pages.
        if (isParseablePage(classification.status)) {
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
          await enqueueParse({ universityId: university.id, snapshotId: snapshot.id, crawlJobId });
          await logAction({
            university_id: university.id,
            discovered_link_id: link.id,
            action: CrawlAction.CHUNK_CONTENT,
            status: "OK",
            message: `${sections.length} sections chunked`,
          });
        }

        // Discovery: score links, then record them in ONE batched DB insert
        // (not one-write-per-link, which was the throughput bottleneck).
        if (depth >= env.MAX_CRAWL_DEPTH) return;
        const toEnqueue: { url: string; userData: CrawlUserData }[] = [];
        const newRows: Parameters<typeof linkRepository.createManyDiscovered>[0] = [];
        for (const { url, text } of extracted.internal_links) {
          if (!isSameDomain(url, university.base_url)) continue;
          if (isResume && isDone(url)) continue; // already crawled in a prior run — don't re-queue
          const f = filterLink(url);
          if (f.rejected && !f.isPdf) continue;
          const urlHash = hashUrl(url);
          if (seenHashes.has(urlHash)) continue; // dedupe within this run
          seenHashes.add(urlHash);
          const canonical = canonicalizeUrl(url);
          if (f.isPdf) {
            newRows.push({ university_id: university.id, url, url_hash: urlHash, canonical_url: canonical, link_text: text, link_score: 0, depth: depth + 1, status: LinkStatus.PDF_DEFERRED });
            // HTML-FIRST: also chase the HTML course page this PDF belongs to, so the
            // real web page (with entry requirements inline) is crawled — even on a
            // site that only LINKS the PDF. The PDF stays a last-resort fallback.
            const htmlPage = htmlPageFromPdf(url);
            if (htmlPage && isSameDomain(htmlPage, university.base_url) && !filterLink(htmlPage).rejected) {
              const hHash = hashUrl(htmlPage);
              if (!seenHashes.has(hHash) && !(isResume && isDone(htmlPage))) {
                const { score } = scoreLink({ url: htmlPage, anchorText: text, baseUrl: university.base_url });
                if (dispositionFor(score, env.MIN_LINK_SCORE) !== "SKIP") {
                  seenHashes.add(hHash);
                  const hStatus = score >= env.MIN_LINK_SCORE ? LinkStatus.QUEUED : LinkStatus.LOW_CONFIDENCE_PAGE;
                  newRows.push({ university_id: university.id, url: htmlPage, url_hash: hHash, canonical_url: canonicalizeUrl(htmlPage), link_text: text, link_score: score, depth: depth + 1, status: hStatus });
                  toEnqueue.push({ url: htmlPage, userData: { depth: depth + 1, linkScore: score, linkText: text } });
                }
              }
            }
            continue;
          }
          // ELIGIBILITY-FOCUSED discovery: follow links that are relevant
          // (course / admission / eligibility / international, or a section that
          // leads to them) and SKIP purely-generic pages (news, staff, events).
          // The sitemap already provides the full course inventory, so this is
          // both FAST (no crawling thousands of irrelevant pages → <1h/uni) and
          // complete for eligibility URLs. Lower "Min link score" to widen.
          const { score } = scoreLink({ url, anchorText: text, baseUrl: university.base_url });
          const disposition = dispositionFor(score, env.MIN_LINK_SCORE);
          if (disposition === "SKIP") continue; // generic page — don't follow/record
          const status = disposition === "EXTRACT" ? LinkStatus.QUEUED : LinkStatus.LOW_CONFIDENCE_PAGE;
          newRows.push({ university_id: university.id, url, url_hash: urlHash, canonical_url: canonical, link_text: text, link_score: score, depth: depth + 1, status });
          toEnqueue.push({ url, userData: { depth: depth + 1, linkScore: score, linkText: text } });
        }
        if (newRows.length) result.linksFound += await linkRepository.createManyDiscovered(newRows);
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
        const human = humanizeError(error); // plain-English reason for the user
        try {
          const link = await linkRepository.upsert({
            university_id: university.id,
            url: request.url,
            url_hash: urlHash,
            status: LinkStatus.BROKEN_LINK,
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
  await recordDiscovery(university.base_url, university.name, 100, 0, LinkStatus.QUEUED);
  await universityRepository.updateCrawlStatus(university.id, "DISCOVERING");

  // Sitemap seeding (full course inventory). Records every relevant URL so none
  // are silently missed, and queues the top ones for full page visits.
  const seeds: { url: string; userData: CrawlUserData }[] = [];
  if (process.env.ENABLE_SITEMAP !== "false") {
    try {
      const smUrls = await discoverSitemapUrls(university.base_url);
      const smRows: Parameters<typeof linkRepository.createManyDiscovered>[0] = [];
      let seeded = 0;
      for (const url of smUrls) {
        if (!isSameDomain(url, university.base_url)) continue;
        const f = filterLink(url);
        const urlHash = hashUrl(url);
        if (seenHashes.has(urlHash)) continue;
        if (f.isPdf) {
          seenHashes.add(urlHash);
          smRows.push({ university_id: university.id, url, url_hash: urlHash, canonical_url: canonicalizeUrl(url), link_text: "(sitemap pdf)", link_score: 0, depth: 1, status: LinkStatus.PDF_DEFERRED });
          continue;
        }
        if (f.rejected) continue;
        const { score } = scoreLink({ url, anchorText: "", baseUrl: university.base_url });
        // GUARANTEED COURSE COVERAGE: a course-catalog page (/courses, /programmes,
        // /programs, /degrees) is ALWAYS seeded from the sitemap — even below
        // MIN_LINK_SCORE — so no hyperparameter value can ever cause a real course to
        // be skipped. The sitemap is the authoritative course inventory; only
        // NON-catalog URLs are score-gated. (Non-course pages under the catalog, e.g.
        // short-courses/CPD, are still filtered out later at export time.)
        const isCatalog = /\/(courses?|programmes?|programs?|degrees?)\//i.test(url.toLowerCase());
        if (!isCatalog && score < env.MIN_LINK_SCORE) continue;
        seenHashes.add(urlHash);
        const seedScore = isCatalog ? Math.max(score, env.MIN_LINK_SCORE) : score;
        smRows.push({ university_id: university.id, url, url_hash: urlHash, canonical_url: canonicalizeUrl(url), link_text: "(sitemap)", link_score: seedScore, depth: 1, status: LinkStatus.QUEUED });
        seeded += 1;
        // Course-catalog seeds are never dropped by the visit cap (added first/forefront).
        if (isCatalog || seeds.length < 3000) seeds.push({ url, userData: { depth: 1, linkScore: seedScore, linkText: "(sitemap)" } });
      }
      if (smRows.length) result.linksFound += await linkRepository.createManyDiscovered(smRows);
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
  // last time) so the crawl continues from where it stopped.
  if (isResume) {
    for (const p of pendingFrontier) {
      if (isDone(p.url)) continue;
      seeds.push({ url: p.url, userData: { depth: 1, linkScore: p.score, linkText: "(resumed)" } });
    }
    await logAction({
      university_id: university.id,
      action: CrawlAction.DISCOVER_LINKS,
      status: "OK",
      message: `Resuming crawl — ${doneUrls.size} pages already done, ${pendingFrontier.length} pending to continue.`,
    });
  }

  // HARD time cap: a single university must finish in under MAX_CRAWL_MINUTES no
  // matter what. The in-handler check stops queueing new pages; this timer is the
  // backstop that force-stops the engine even if it's mid-phase or idle, so the
  // job always returns within the budget (the next university starts on schedule).
  const budgetTimer =
    env.MAX_CRAWL_MINUTES > 0
      ? setTimeout(() => {
          budgetHit = true;
          void crawler.autoscaledPool?.abort().catch(() => {});
          void crawler.teardown().catch(() => {}); // hammer: close browsers + end run()
        }, Math.max(1000, deadline - Date.now())) // fire at the start-based deadline
      : null;

  try {
    await crawler.run([
      { url: university.base_url, userData: { depth: 0, linkScore: 100, linkText: university.name } },
      ...seeds.map((s) => ({ url: s.url, userData: s.userData })),
    ]);
  } catch (err) {
    // A time-budget stop (or a late page error after the pool is told to stop)
    // must NOT fail the whole job — we keep everything crawled so far. Genuine
    // per-page failures are already logged in failedRequestHandler.
    logger.warn({ universityId: university.id, err: String(err), budgetHit }, "crawl run ended early");
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }

  // Final authoritative recompute of the headline counters from the real tables.
  await flushCounters();

  return result;
}
