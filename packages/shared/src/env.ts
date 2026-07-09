import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Centralized, validated runtime configuration. Import `env` from here rather
 * than reading `process.env` directly so every service shares one source of
 * truth and fails fast on misconfiguration.
 *
 * On import we load the nearest `.env` walking up from the current working
 * directory (tsx does not auto-load .env). Existing process.env values win, so
 * Docker's injected env_file vars are never overridden.
 */
let dotenvLoaded = false;
function loadDotenvUpwards(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
// Side effect on module load: ensure .env is available before any consumer
// (e.g. PrismaClient) reads process.env.
loadDotenvUpwards();

const numeric = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().finite());

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : /^(1|true|yes|on)$/i.test(v)))
    .pipe(z.boolean());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  AI_PROVIDER: z
    .enum(["ollama", "openai", "anthropic", "gemini", "none"])
    .default("ollama"),

  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_EXTRACTION_MODEL: z.string().default("qwen3:8b"),
  OLLAMA_FALLBACK_MODEL: z.string().default("gemma3:12b"),
  OLLAMA_TIMEOUT_MS: numeric(120000),
  OLLAMA_MAX_INPUT_CHARS: numeric(12000),
  OLLAMA_NUM_CTX: numeric(8192),
  OLLAMA_TEMPERATURE: numeric(0),

  OPENAI_API_KEY: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  ANTHROPIC_BASE_URL: z.string().optional().default(""),
  ANTHROPIC_MODEL: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),

  CRAWL_CONCURRENCY: numeric(2),
  // ADAPTIVE UNIVERSITY CONCURRENCY (opt-in). When on, the crawl worker STARTS at
  // CRAWL_CONCURRENCY and steps toward CRAWL_CONCURRENCY_MAX only while free RAM
  // (and CPU load, where the OS reports it) leave headroom — and steps back down
  // under memory pressure. This is how to scale toward many parallel universities
  // WITHOUT blindly setting 20 workers and thrashing a small machine. The Prisma
  // pool is sized for CRAWL_CONCURRENCY_MAX at startup so scaling up can't exhaust
  // DB connections.
  CRAWL_ADAPTIVE_CONCURRENCY: boolish(false),
  CRAWL_CONCURRENCY_MAX: numeric(5),
  PARSE_CONCURRENCY: numeric(1),
  PER_DOMAIN_CONCURRENCY: numeric(1),
  CRAWL_DELAY_MS: numeric(2000),
  MAX_CRAWL_DEPTH: numeric(4),
  // Raised from 300→800: large universities (e.g. Canberra, Sydney) have 600-1200+
  // course pages. At 300 the fast lane hits budget mid-crawl, leaves ~200 QUEUED
  // in DB unprocessed, and the crawl ends STOPPED instead of COMPLETED — requiring
  // manual resume. At 800 a typical university completes in a single pass.
  MAX_PAGES_PER_UNIVERSITY: numeric(800),
  MIN_LINK_SCORE: numeric(40),
  // AUTO DEEP DISCOVERY (bounded): when an eligibility crawl's frontier drains but
  // course COVERAGE is low (few validated courses vs the course surface discovered),
  // re-seed course hubs (listings/finders/faculty/department pages) + known-but-
  // unfetched course URLs to recover courses hidden behind JS finders / pagination /
  // seed caps. Strictly bounded: at most DEEP_DISCOVERY_MAX_PASSES extra passes,
  // each capped + de-duplicated, so it never becomes an unbounded re-crawl.
  DEEP_DISCOVERY_MODE: boolish(true),
  DEEP_DISCOVERY_MAX_PASSES: numeric(3),
  // SOFT time target per university (minutes) — NEVER a cap. The crawl always
  // runs to completion (every discovered page is visited; no data is dropped for
  // time); per-page costs are tuned so a typical university closes well under
  // this target. Exceeding it only logs a notice in the crawl log. 0 = no notice.
  MAX_CRAWL_MINUTES: numeric(40),
  // What the crawl focuses on: "both" (eligibility + scholarship), "eligibility"
  // (course/admission entry-criteria only) or "scholarship" (funding only). The
  // scorer adds the chosen category's signals so the crawl follows the right
  // pages; exports stay separate either way. Restart the engine to apply.
  CRAWL_TARGET: z.enum(["both", "eligibility", "scholarship"]).default("both"),

  // --- Runtime optimizations (redesign) — all default ON, individually
  // switchable so a site that behaves badly can fall back to the old path. ---
  // Step 2: replace the fixed per-request CRAWL_DELAY_MS sleep with signal-driven
  // adaptive throttling (healthy → no sleep; 429/5xx → back off). CRAWL_DELAY_MS
  // becomes the BACKOFF unit rather than a per-page tax.
  CRAWL_ADAPTIVE_THROTTLE: boolish(true),
  // Politeness floor for the adaptive throttle: the per-request delay never
  // decays below this. Zero-delay bursting is what gets an IP flagged by CDN
  // bot protection (Cloudflare challenged every route after a day of it).
  CRAWL_MIN_DELAY_MS: numeric(100),
  // Steps 3 & 4: HTTP-first discovery of sitemaps/robots + probing likely
  // course/scholarship catalogue & finder URLs before broad graph crawling.
  HTTP_FIRST_DISCOVERY: boolish(true),
  // Step 3 (full): HTTP-first PAGE FETCHING — the fast lane. Discovery/rejected
  // pages are fetched with plain HTTP + parsed without a browser (~10-20x
  // cheaper); Playwright serves only JS shells, bot challenges, dynamic
  // finders, and validated targets (proof screenshot + parse-grade snapshot).
  HTTP_FIRST_FETCH: boolish(true),
  // When the fast lane hits a bot-protection wall (Cloudflare "Just a moment…"
  // challenge, or a 403/429/503), should it ESCALATE that page to the slow
  // headless browser lane? Default FALSE — a headless browser almost never
  // solves a managed challenge, so escalating just grinds the browser lane at
  // ~5 pages/min per page for near-zero success AND keeps hammering the flagged
  // host. Instead we mark the page BLOCKED (recorded, audited) and let the
  // coverage-recovery pass re-crawl it via the FAST lane on the next run once
  // the host clears — much faster, and it stops extending the block. Set true
  // to restore the old always-escalate behavior.
  ESCALATE_BOT_BLOCKS: boolish(false),
  // ADAPTIVE ESCALATION: when ESCALATE_BOT_BLOCKS is on, cap how many bot-blocked
  // pages PER REGISTRABLE DOMAIN may be escalated to the browser as PROBES before
  // the host is declared protection-blocked (every further bot-blocked page on it
  // is then recorded BLOCKED fast, never browser-escalated). This is what stops a
  // single Cloudflare-protected university from dragging the whole crawl to
  // browser speed: it browser-probes a few pages, and if the host is a managed
  // challenge the browser can't pass, it gives up ON THE BROWSER for that host
  // (pages are deferred BLOCKED + re-crawled via the fast lane once the host
  // clears). Legitimate browser needs (JS shell / thin / dynamic finder / network)
  // are never capped. 0 disables the cap (old always-escalate behavior).
  HOST_BROWSER_PROBE_BUDGET: numeric(5),
  // Step 7: stop expanding LOW-tier (discover-only) links from branches that have
  // been visited PRUNE_BRANCH_MIN_PAGES times with zero validated targets. Never
  // touches course/eligibility/scholarship candidate links or catalogue seeds.
  PRUNE_DEAD_BRANCHES: boolish(true),
  // Was 60: a barren low-tier branch (generic section pages with no keyword
  // signal, e.g. /research/, /about/ subsections) burned up to 60 full page
  // fetches before being abandoned — real crawl-time waste. Only ever affects
  // LOW-tier discover-only links (see branchYield.ts) — course/eligibility/
  // scholarship candidates are never pruned, so coverage is unaffected.
  PRUNE_BRANCH_MIN_PAGES: numeric(25),

  // CATALOG-DRIVEN CRAWL (biggest time win): the deliverable is the course /
  // eligibility / scholarship pages, and those are enumerated directly by the
  // sitemap census + the catalogue/finder inventory probe. So instead of
  // breadth-first crawling the ENTIRE site graph (~18k pages to surface ~600
  // courses — a 30:1 waste, most of it in /studyplan, /store, /research,
  // /current-students, /tag, /__data … which yield ZERO targets), only FOLLOW
  // links that are (a) target candidates, (b) course/scholarship listings &
  // finders, or (c) course-section navigation hubs. Generic low-value pages are
  // still recorded for audit but never fetched. Coverage is preserved: the
  // sitemap already holds the full course inventory and every listing/hub that
  // contains course links is still crawled. Set false for the old exhaustive
  // graph crawl.
  CATALOG_DRIVEN_CRAWL: boolish(true),
  // Fast-lane (HTTP, no browser) worker count — how many pages are fetched +
  // parsed + validated in parallel. Per-domain politeness still paces requests
  // (acquireSlot), so this raises throughput without bursting a single host.
  FAST_LANE_CONCURRENCY: numeric(8),

  // --- LEAN VALIDATION (speed): the deliverable is the course/eligibility URL +
  // whether it works; the extras below cost crawl time without changing that. ---
  // Proof SCREENSHOTS of validated course pages. OFF by default. The screenshot
  // is the single most expensive per-target op: it forces every validated page
  // onto the slow browser lane. With it OFF, validated targets are finalised
  // INLINE in the fast lane — much faster AND more reliable, because there is no
  // separate post-crawl browser phase that can fail/stall and leave a crawl
  // marked "completed" with its validated URLs never recorded.
  CAPTURE_SCREENSHOTS: boolish(false),
  // Store each page's raw HTML + visible text to disk. OFF by default — not part
  // of the deliverable, and the course-criteria parser reads the separately
  // saved CLEANED sections, not these raw artifacts. Saves disk I/O per page.
  STORE_PAGE_ARTIFACTS: boolish(false),

  SCREENSHOT_STORAGE_PATH: z.string().default("./storage/screenshots"),
  HTML_STORAGE_PATH: z.string().default("./storage/html"),
  TEXT_STORAGE_PATH: z.string().default("./storage/text"),
  EXPORT_STORAGE_PATH: z.string().default("./storage/exports"),

  USER_AGENT: z
    .string()
    .default("CLGSearchBot/1.0 (+https://your-contact-page)"),

  API_PORT: numeric(4000),
  WEB_PORT: numeric(3000),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Lazily-validated env. Safe to import anywhere. */
export const env: Env = new Proxy({} as Env, {
  get(_t, prop: string) {
    return loadEnv()[prop as keyof Env];
  },
});
