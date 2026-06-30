# CLG Search — Complete Documentation

> **What it is:** A local-first, fully **free / open-source** system that automatically finds the
> **eligibility / entry-criteria URLs** *and* **scholarship / funding URLs for international students** —
> at **both** the *university level* and the *individual course level* — across many university
> websites, **validates** every link (reachable **and** genuinely an eligibility/scholarship page),
> removes broken/duplicate links, keeps every level strictly separate, and exports clean
> **Excel / CSV** files. It can then auto-fill those results into the **Aliff Super Admin** CRM.

Everything runs on your own machine. No paid API keys are required anywhere — the crawler is local,
AI review uses local **Ollama**, and web-search fallback uses **DuckDuckGo / SearXNG** (free, no key).

> **It is not a one-time tool.** University requirements, scholarships and links change every year.
> The built-in **Change Monitor** re-checks every URL you exported and tells you exactly what is
> **NEW / CHANGED / BROKEN / FIXED** since last time — the recurring-value engine that keeps the data
> you pushed to your CRM continuously fresh (see §6a). Add to this **website auto-discovery** (paste
> just a university name + country and it finds the official site for free), **one-click backup /
> restore**, and **RAM-based auto-tuning** of the crawl, and it stays useful long after the first run.

---

## 1. Tools & Technology Used (crisp points)

**Languages / runtime**
- **TypeScript** (strict, ESM everywhere) — one language across the whole stack.
- **Node.js v24** — runtime.
- **tsx** — runs TypeScript directly (no build step in dev).

**Monorepo / build**
- **pnpm workspaces** (`pnpm-workspace.yaml`) — manages all apps + packages together.
- **Turborepo** (`turbo.json`) — runs build / typecheck / lint / test across the workspace.
- **corepack** — pins the pnpm version (9.12.0).

**Frontend (the website)**
- **Next.js 14** (App Router) — the dashboard.
- **React 18** — UI.
- **Tailwind CSS** — styling (glassmorphism, light + dark mode, responsive).
- **Framer Motion** — animations / live transitions.

**Backend (API)**
- **Fastify 5** — HTTP API server.
- **Zod** — request/response validation & schemas.
- **@fastify/cors, helmet, multipart, rate-limit, static** — CORS, security headers, file upload (CSV/XLSX), rate limiting, serving export files for download.

**Crawler / extraction**
- **Crawlee** — crawling framework (queueing, polite crawling).
- **Playwright (Chromium)** — real headless browser; renders JavaScript-heavy pages, clicks "Load more", infinite-scroll, and verifies links/screenshots.
- **ExcelJS** + **fast-csv** — read/write Excel and CSV files.

**Data / queue**
- **PostgreSQL 16** — main database.
- **Prisma 5** — ORM + migrations + typed client.
- **Redis 7** — job queue backend.
- **BullMQ** + **ioredis** — background job queues (crawl / parse workers).

**AI (optional, all free/local)**
- **Ollama** — local LLM runtime for AI auto-review (default models `qwen3:8b` / `gemma3:12b`).
- (Paid OpenAI/Anthropic/Gemini adapters exist but are **off by default** — never required.)
- **zod-to-json-schema** — forces the model to return schema-valid JSON.

**Free web search (no API key)**
- **DuckDuckGo HTML endpoint** — default search fallback, zero setup, no key.
- **SearXNG** (optional) — self-hosted open-source meta-search, set via `SEARX_URL`.

**Aliff CRM automation**
- **Playwright** + **xlsx** — reads the export files and auto-fills the Aliff Super Admin portal.

**Infra / dev**
- **Docker + Docker Compose** — runs Postgres + Redis (and optionally the whole stack).
- **Vitest** — unit tests (URL invariant, link scorer, chunker, export gate).
- Windows **.bat** scripts — one-click start of API / Web / Crawler (portable, work on any PC).

---

## 2. Architecture (the monorepo)

```
JOB - CLAUDE/                 ← repo root
├─ apps/
│  ├─ web/        @clg/web      Next.js dashboard (the website)
│  ├─ api/        @clg/api      Fastify REST API (the brain the website talks to)
│  └─ crawler/    @clg/crawler  Crawlee + Playwright workers + CLI scripts
├─ packages/
│  ├─ database/   @clg/database Prisma schema + client + migrations
│  ├─ queue/      @clg/queue    BullMQ + Redis job queues
│  ├─ parser/     @clg/parser   eligibility parser interface + AI/rule parsers
│  └─ shared/     @clg/shared   types, env, storage paths, KEYWORDS vocabulary
├─ tools/
│  └─ aliff-automation/         Playwright bot that fills the Aliff CRM
├─ storage/        screenshots / html / text / exports / keywords.json / overrides
├─ scripts/        run-api.bat, run-web.bat, run-crawler.bat
├─ docker-compose.yml, .env / .env.example, turbo.json, pnpm-workspace.yaml
└─ DOCUMENTATION.md (this file), README.md
```

**How the parts talk:**
`Website (Next.js)` → calls → `API (Fastify)` → reads/writes → `Postgres (Prisma)` and
queues jobs in `Redis (BullMQ)` → picked up by `Crawler workers (Crawlee + Playwright)` →
results written back to Postgres + `storage/`. AI review calls local **Ollama**; search fallback
calls **DuckDuckGo / SearXNG**. The website polls the API for **live progress** everywhere.

---

## 3. The Complete Process (end-to-end pipeline)

The dashboard is organised as a **4-step pipeline**, plus an **Advanced** section (Review links,
Criteria, Coverage, Change Monitor, Logs, Storage) and configuration.

> **Single-pass crawl & validate (the key design).** Crawl and validation are **one process**, not
> two. As the engine opens each page it **validates it inline** — the page's own text must actually
> prove entry-requirement (eligibility) / scholarship content, not just match a keyword in the URL —
> and the confirmed link streams into the live **Validated URLs** feed immediately, one-by-one, before
> moving to the next URL. Because the page text is already in hand during the crawl, this costs almost
> nothing and removes the old separate "content-verify the whole corpus again" pass — so the whole run
> finishes faster. A later **Revalidate** step then only has to re-check reachability, de-duplicate, and
> drop 404s.

**Step 1 — Universities (upload).**
Add universities one-by-one or bulk-import a CSV/XLSX. The importer is **format-flexible** — it
auto-detects the name/country/website columns regardless of header names or order, so almost any
spreadsheet works. The **only required input is the university name**; country helps accuracy and the
website is optional. If a website is missing, **"Find website"** auto-discovers the official site for
free (Wikidata `P856` → Wikipedia → DuckDuckGo, with a strict name-match guard so it never picks the
wrong institution). You can delete one or all (a destructive **"Delete all"** requires typing `DELETE`,
and an automatic backup is taken first). Use **Backup / Restore** to snapshot or roll back at any time.

**Step 2 — Crawl & Validate (single pass).**
Start the crawl from the UI. For each URL the crawler crawls it **and validates it inline** — it
content-checks the page text against the eligibility (evidence) / scholarship vocabulary, marks the
link `content_verified` with a proof snippet, and the validated link appears live in the **Validated
URLs** feed straight away (no second pass). For each university the crawler:
- Reads `robots.txt`, respects crawl-delay, uses 1 request/domain politely.
- Uses **Playwright/Chromium** to load pages (incl. JavaScript), clicks **Load more / Show more /
  View all**, and **infinite-scrolls** so dynamically-loaded courses are not missed.
- Discovers links and **scores** each one using the **keyword vocabulary** (international +45,
  eligibility +40, scholarship +38, course/structural signals, same-domain, shallow-depth). Score ≥ 40
  → extract, 20–39 → discover-only, < 20 → skip.
- Is **speed-optimised**: blocks images/media/fonts/stylesheets/analytics, settles on
  `domcontentloaded` (only "finder"/table pages do the full reveal + network-idle), batches DB writes,
  and prioritises high-value links — fast enough to target sub-1-hour per university while still
  finding all eligibility links.
- Saves discovered links, page snapshots, and screenshots. Live progress + ETA shown in the UI.

**RAM auto-tune (set it once, on the Crawl page).** Pick your machine's RAM and the crawl settings
(parallel browsers, depth, page budget) are set for you — ≤8 GB → 2 browsers, ≤16 GB → 3, ≤32 GB → 6,
≤64 GB → 10, more → 12. You can still override every value manually. This keeps the crawl stable on
small machines and fast on big ones.

**Resume & stop (never lose work).** Stop the engine any time; **Resume** continues *exactly* where it
was interrupted — completed pages are skipped and the pending frontier is re-seeded, so nothing is
re-crawled or lost. All errors are shown in **plain English** (e.g. "the site refused the connection",
not `ECONNREFUSED`).

**Step 3 — Revalidate (de-dup + drop 404s).**
After the single-pass crawl has extracted every link, this fast finishing pass:
- **Re-checks every link for reachability** (HTTP HEAD/GET with real browser headers, with a
  real-Chromium fallback for bot-protected pages), removes broken links, and **de-duplicates** globally.
- Splits results: **university-level** eligibility vs **course-level** eligibility — **never mixed**.
- Exports separate **Excel + CSV** per level (and the separate scholarship files).
- Content was already verified **inline during the crawl** (Step 2), so this stage is lean and quick —
  it does not re-open every page to re-confirm evidence.

**Step 4 — Export & Aliff.**
Build the Aliff input files from the validated exports, then run the **Aliff auto-fill** with your
login (DRY-RUN by default) and download the deliverables. *(See "Operations / Aliff push" below.)*

**Per-university + complete export (timestamped).** Alongside the combined `*-FINAL` files, Revalidate
also writes (and you can re-run on demand from Export & Aliff): a **separate CSV + Excel per university**
under `storage/exports/by-university/`, and one **complete** all-in-one workbook
`eligibility-ALL-INTERNATIONAL_<localstamp>.xlsx/.csv`. Every file's name and an `exported_at` column
carry the export time in the **machine's local timezone** (e.g. IST). The canonical `*-FINAL` files are
untouched, so Aliff / Monitor / counts keep working. `apps/crawler/src/export-by-university.ts` produces
these (run via `POST /ops/export/by-university`).

**Scholarship export (separate operation).**
Scholarship/funding URLs are extracted and exported **completely separately** from eligibility — one
crawl can feed both, but they never mix. The scholarship export scans discovered links for
scholarship-keyword matches (in URL + title), splits **university-level** vs **course-level** funding,
and writes its own `scholarships-INTERNATIONAL-FINAL.xlsx` / `.csv`. The Aliff push then pastes these
into the dedicated *University Scholarship Links* / *Course Scholarship Links* fields.

**Download files (Advanced → Download files).**
Download the validated deliverables, grouped on the Downloads page: **Validated eligibility URLs**
(university + course), **Scholarship URLs**, the **coverage** report, and the **Aliff input** files.
(Also available directly on the **Export & Aliff** page.)

**Coverage Reconciliation (the "no silent misses" layer).**
For every official course discovered, it is mapped to an eligibility URL and given a **status**:
`FOUND` (on the course page) · `SHARED` (mapped to the university admissions/international page) ·
`NEEDS_REVIEW` · `NOT_FOUND`. A university is **COMPLETE** only when its review queue is empty.
The **Coverage** page shows a completion report + a review queue with recall boosters:
- **Auto-resolve** — map review items to the shared admissions page where one exists.
- **Predict URLs** — test common patterns (`/entry-requirements`, `/admissions`, …) and keep verified hits.
- **AI auto-review** — ask local Ollama to pick the best eligibility URL per course (off unless `AI_PROVIDER=ollama`).
- **Web search (free)** — DuckDuckGo/SearXNG search restricted to the university's own domain, then content-verified.
- Manual **Found / Shared / Not found** buttons per item.
Export a per-course **coverage-FINAL.csv** (one row per official course, with evidence + confidence).

**Change Monitor (keep the data fresh — the recurring-value step).**
Open **Monitor → Change Monitor** and click **Run check now**. It re-fetches every URL you already
exported (university eligibility, course eligibility, **and** scholarships), fingerprints each page,
and reports what is **NEW / CHANGED / BROKEN / FIXED** since the last check — so your CRM data never
silently goes stale. Run it on a schedule (e.g. weekly). Details in **§6a**.

**Operations / Aliff push.**
Generate the Aliff input files and run the **Aliff automation** to auto-fill the CRM:
University eligibility → *Manage Universities*; Course eligibility → *Manage Courses*. Defaults are
**safe**: `DRY_RUN` (no final save) and `OVERWRITE=false`.

---

## 4. The Website (page by page)

Path: `apps/web/app/`. Built with Next.js App Router; every page is **live** (polls the API),
fully **responsive**, with **light + dark mode** and glassmorphism + motion.

| Page | Route | What it does |
|------|-------|--------------|
| **Home / Hub** | `/` (`page.tsx`) | 4 pipeline step-cards with done/active/todo state, animated totals. |
| **Guide** | `/guide` | Crisp step-by-step "how to use" instructions. |
| **Pipeline** | | |
| **Universities** (1) | `/universities` | Add / bulk-upload (CSV/XLSX) / delete universities; start crawl. |
| **Crawl & Validate** (2) | `/crawl` | Single pass: crawl + **validate each URL inline**; configure crawl (browsers, pages, depth, delay) + **live progress & ETA** + the **live Validated URLs feed**. |
| **Revalidate** (3) | `/revalidate` | One click: re-check reachability, **de-dup**, **drop 404s**, write the FINAL eligibility + scholarship Excel/CSV (per level, never mixed). |
| **Export & Aliff** (4) | `/export` | Build Aliff inputs + run Aliff auto-fill (DRY_RUN / LIVE, login creds) + scholarship export + download deliverables. |
| **Advanced** | | |
| **Review links** | `/links` | Browse & filter discovered links, approve/reject. |
| **Criteria** | `/criteria` | Review extracted course-criteria records (approve/edit/reject). |
| **Download files** | `/exports` | Grouped downloads: validated eligibility, scholarships, coverage, Aliff inputs. |
| **Coverage** | `/coverage` | Completion report + review queue + AI / Predict / **Web search (free)** / Auto-resolve / Export. |
| **Change Monitor** | `/monitor` | Re-check exported URLs; live **NEW / CHANGED / BROKEN / FIXED** feed + counts (the freshness engine). |
| **Logs** | `/logs` | All crawl/validation logs incl. 404 / bot-protected reasons; clear logs. |
| **Settings** | `/settings` | Every hyperparameter (no command line needed) **+ the Keyword editor** (4 categories). |

**Key UI building blocks** (`apps/web/components/`):
- `AppShell.tsx`, `Header.tsx` (theme toggle, ⌘K command palette), `Nav.tsx` (sectioned, step badges).
- `ui.tsx` (glass Card, Button, StatCard, ProgressBar, Skeleton, EmptyState), `FileDropzone.tsx`,
  `AnimatedCounter.tsx`, `Toast.tsx`, `CommandPalette.tsx`, `motion.tsx`, `icons.tsx`, `PageHeader.tsx`.
- **`KeywordEditor.tsx`** — the dynamic keyword editor embedded in Settings (eligibility / international /
  evidence / **scholarship**).
- `BackdropFX.tsx` + `Hero.tsx` — animated background (constellation + beams) and premium hero.
- `Confirm.tsx` — portal-rendered confirm dialog with optional **type-to-confirm** (e.g. `DELETE`).
- `apps/web/lib/useAutoRefresh.ts` — keeps every page live and **in sync across pages** (a delete/import/
  crawl elsewhere is reflected here within seconds, and instantly on focus).
- `apps/web/lib/api.ts` — typed API client (`API_URL` trimmed/cleaned to avoid URL bugs).

---

## 5. The Code (apps & packages explained)

### `packages/shared` (`@clg/shared`) — the foundation
- **`keywords.ts`** — the **central, editable keyword vocabulary**. `DEFAULT_KEYWORDS` is a large
  multilingual synonym set (English + German/French/Spanish/Italian/Portuguese/Chinese/Japanese) in
  **four** lists: **eligibility**, **international**, **evidence**, **scholarship**. `getKeywords()`
  merges defaults + your custom additions (from `storage/keywords.json`) generically over all
  categories, and `keywordsToRegex()` compiles a list into a case-insensitive regex (spaces ↔
  `-`/`_`). Used by the link scorer, validators, search, scholarship export, and the Change Monitor.
- **`errors.ts`** — `humanizeError()` maps technical errors (ECONNREFUSED, ETIMEDOUT, Prisma codes,
  fetch/Playwright timeouts, 403/429/404/5xx, Docker/Redis down) to plain-English messages. The API
  error handler and crawler use it so the UI never shows a raw stack/code.
- `env.ts`, `logger`, `storage/` (paths + `repoRoot()`), `url/canonicalize.ts` (strip tracking
  params, normalise, hash), shared `types/` and Zod `schemas/`.

### `packages/database` (`@clg/database`) — data
- **Prisma schema** with models: `University, DiscoveredLink, PageSnapshot, CourseCriteria,
  CrawlLog, CrawlJob, Export` and enums (`CrawlStatus, LinkStatus, ReviewStatus, DegreeLevel,
  ParserType, JobType, JobStatus, CrawlAction, LogStatus, ExportType`).
- A raw-SQL **CHECK** constraint enforces every `criteria_url` is a real `http(s)` URL.
- Exports a singleton `prisma` client.

### `packages/queue` (`@clg/queue`) — background jobs
- BullMQ queues over Redis (ioredis) for crawl + parse work, with retry/backoff.

### `packages/parser` (`@clg/parser`) — eligibility extraction
- A provider-agnostic `EligibilityParser` interface + orchestrator (rule filter first, then AI).
- Ollama adapter uses structured JSON output (`zod-to-json-schema`); rule-based fallback always works.

### `apps/crawler` (`@clg/crawler`) — the engine
- `crawl/runCrawl.ts` — the Crawlee/Playwright crawl (JS reveal, infinite scroll, `domcontentloaded`).
  **Now validates inline (single pass):** for each crawled page it runs the eligibility (evidence) /
  scholarship vocabulary over the already-extracted page text and, per `CRAWL_TARGET`, sets
  `content_verified` + an `evidence` snippet on the link — which feeds the live **Validated URLs** feed
  (`GET /links/validated`). This replaces the old separate whole-corpus content-verify pass.
- `discovery/linkScorer.ts` — **keyword-driven scoring** (uses `@clg/shared` keywords).
- `validation/validatePage.ts`, `extraction/extractPage.ts`, `cleaning/`, `chunking/` — validate,
  extract text/tables, clean boilerplate, chunk for parsing.
- `recheck.ts` — the **Revalidate** step: **re-validate all links** (reachability + browser fallback +
  dedup + level split + INTL-only modes), writes the FINAL Excel/CSV. Orchestrated for one-click use by
  `apps/api/src/services/revalidateService.ts` (university → course → scholarship).
- **`verify-eligibility.ts`** — **content-verifies** each exported URL (opens it, checks evidence
  words) → writes `*-VERIFIED.csv` (real deliverable) + `*-REVIEW.csv` (with reason + snippet).
- `workers/` — BullMQ crawl & parse workers. CLI helpers: `enqueue-all.ts`, `finalize.ts`,
  `report-urls.ts`, `progress.ts`.

### `apps/api` (`@clg/api`) — the brain
- **Routes** (`src/routes/`): `universities, links, criteria, exports, coverage, ops, monitor, jobs,
  logs, stats, config, health`.
- **Services** (`src/services/`):
  - `coverageService.ts` — Coverage Reconciliation: status per course, review queue, overrides,
    **AI auto-review**, **Predict URLs**, **free web-search fallback** (DuckDuckGo/SearXNG +
    content verify), exact-URL resolution, coverage export.
  - **`monitorService.ts`** — the **Change Monitor**: re-fetches every exported URL, fingerprints the
    eligibility/funding-relevant sentences (SHA-256), compares to `storage/monitor.json`, and
    classifies **NEW / CHANGED / BROKEN / FIXED**. Runs in the background with a concurrency pool;
    exposes `runMonitor()`, `getMonitorProgress()`, `getMonitorSummary()`.
  - **`scholarshipService.ts`** — scans discovered links for scholarship-keyword matches, splits
    university vs course level, writes the separate `scholarships-INTERNATIONAL-FINAL.xlsx/.csv`.
  - **`backupService.ts`** — one-click `backupData()` / `listBackups()` / `restoreData()`
    (universities + coverage overrides + keywords → `storage/backups/`); an auto-backup runs before any
    destructive reset.
  - **`urlDiscovery.ts`** — free university-website discovery (Wikidata `P856` → Wikipedia →
    DuckDuckGo) with a strict name-match guard and request throttling.
  - `crawlAdminService.ts` — crawl settings (writes `.env`), **system info (RAM/CPU) for auto-tune**,
    live progress + ETA, clear logs, reset (auto-backup first).
  - `crawlerControlService.ts` — start/stop/restart the crawler worker.
  - `linkValidationService.ts` — live link re-validation (single + batch), GET-probe + **soft-404**
    detection (redirect-to-home + not-found text).
  - `settingsService.ts` — every hyperparameter, with notes, read/written to `.env`.
  - `opsService.ts` — runs export/transform/Aliff subprocesses with progress/ETA parsing.
  - `exportService.ts` / `exportWriter.ts` / `exportGate.ts` (+ test) — the export gate & writers.
- Serves export files statically for download; CORS/helmet/rate-limit applied; the global error
  handler returns **human-readable** messages via `humanizeError()`.

### `tools/aliff-automation` — CRM auto-fill
- Playwright bot that logs into Aliff Super Admin and fills universities/courses from the export
  files — including the separate **scholarship** fields (*University Scholarship Links* / *Course
  Scholarship Links*), matched by university name / URL stem so eligibility and scholarship links land
  in the correct boxes and are never mixed. **Credentials only come from env vars `ALIFF_EMAIL` /
  `ALIFF_PASSWORD`** (never stored/logged). Safe defaults: `DRY_RUN=true`, `OVERWRITE=false`. It never
  re-verifies URLs or web-searches.

---

## 6. Accuracy & "no silent misses" — how correctness is enforced

- **Keyword-driven discovery** — large multilingual vocabulary so eligibility/criteria pages aren't
  missed; **editable from the website** (Settings → Keywords) so you can add site-specific terms.
- **Two-stage validation** — (1) reachable? (HEAD/GET + real-browser fallback for bot blocks);
  (2) *originally an eligibility page?* (open it, confirm evidence text). Broken removed, duplicates merged.
- **Strict level separation** — university-level vs course-level eligibility are exported separately,
  never mixed.
- **Coverage reconciliation** — every official course gets a final status; a university is COMPLETE
  only when nothing is left in review. Honest counts (CONFIRMED vs needs-review) — no over-claiming.
- **Recall boosters** — JS course reveal, URL-pattern prediction, AI auto-review (local), and free
  web-search fallback all feed the review queue, then everything is content-verified before acceptance.

---

## 6a. Recurring value — why it isn't a one-time tool

Extracting every link once is only half the job; the data **decays**. These features keep customers
coming back year after year:

**Change Monitor (the flagship).** Re-checks everything you exported and reports drift:
- **Inputs:** the export CSVs — `eligibility-UNIVERSITY-INTERNATIONAL-FINAL.csv`,
  `eligibility-COURSES-INTERNATIONAL-FINAL.csv`, and `scholarships-INTERNATIONAL-FINAL.csv` (URL +
  university columns are auto-detected).
- **Fingerprint:** each page is fetched and reduced to text; only the **eligibility/funding-relevant
  sentences** (matching the evidence + scholarship keywords) are hashed (SHA-256). So menu/footer/
  cosmetic edits cause **no** noise — only real requirement/scholarship changes do.
- **Classification vs the last run** (`storage/monitor.json`): **NEW** (newly tracked & reachable),
  **CHANGED** (content hash differs), **BROKEN** (was OK, now unreachable/removed), **FIXED** (was
  broken, reachable again).
- **Dashboard (`/monitor`):** *Run check now* with live progress, summary cards (tracked / working /
  broken / changed / new), and a changes feed (type badge · level · university · clickable URL ·
  plain-English note · "x ago"). Tip: schedule it weekly.
- **API:** `POST /monitor/run` · `GET /monitor/progress` · `GET /monitor/summary`.

**Website auto-discovery.** Paste only a university **name** (+ country) and it finds the official
website for free (Wikidata → Wikipedia → DuckDuckGo) — so onboarding new universities never needs
manual URL hunting.

**Backup / Restore + delete guard.** One-click snapshot/rollback of all data, automatic backup before
any reset, and a type-`DELETE` guard so data is never wiped by accident.

**RAM auto-tune.** The crawl right-sizes itself to the machine, so the same product runs well on a
laptop and a workstation without re-configuring.

> **In short:** the first run delivers the links; the Change Monitor (plus easy re-onboarding via
> auto-discovery) is the reason to keep the subscription — it guarantees the customer's CRM stays
> correct as the world's universities change their pages.

---

## 7. Configuration (no command line needed)

Everything is editable in **Settings**; values persist to `.env`. Key knobs:

| Setting | Meaning | Default |
|--------|---------|---------|
| `AI_PROVIDER` | `ollama` / `openai` / `none` | `none` |
| `MAX_PAGES_PER_UNIVERSITY` | crawl page budget per site | 300 |
| `MAX_CRAWL_DEPTH` | how deep to follow links | 4 |
| `MIN_LINK_SCORE` | score needed to extract a link | 40 |
| `CRAWL_CONCURRENCY` / `PER_DOMAIN_CONCURRENCY` | parallelism / politeness | 2 / 1 |
| `CRAWL_DELAY_MS` | delay between requests to a domain | 2000 |
| `SEARX_URL` | optional self-hosted search (else DuckDuckGo) | *(empty)* |
| `ALIFF_EMAIL` / `ALIFF_PASSWORD` | CRM login (env only, runtime only) | *(unset)* |

> **Note:** crawl/AI/keyword changes take effect when the **crawler/API is restarted**
> (`scripts/run-crawler.bat`, and the API for AI/keyword edits). The UI says this on save.

**Editable keywords API:** `GET /ops/keywords` (defaults + your custom) and `PUT /ops/keywords`
(saves to `storage/keywords.json`) — across all **four** categories (eligibility / international /
evidence / scholarship). The Settings page exposes this as the **Keyword editor**.

**Other ops endpoints:** `/ops/system` (RAM/CPU for auto-tune), `/ops/backup` · `/ops/backups` ·
`/ops/restore`, `/ops/crawl/drain`, `/ops/export/scholarships` · `/ops/scholarship-counts`, and the
grouped `/ops/files` (validated eligibility · scholarships · Aliff inputs).

---

## 8. How to Run (any PC)

**Prerequisites:** Node 24+, Docker Desktop, (optional) Ollama for AI review.

**One-time setup**
```bash
corepack enable pnpm
corepack pnpm install
cp .env.example .env        # then adjust ports if needed (we use 5433/6380/4100/3100)
docker compose up -d postgres redis
corepack pnpm db:migrate    # apply schema
corepack pnpm db:seed       # optional sample universities
```

**Start the app (3 windows, or use the .bat scripts)**
```bash
# scripts\run-api.bat       → API   on http://localhost:4100
# scripts\run-web.bat       → Web   on http://localhost:3100
# scripts\run-crawler.bat   → Crawler worker
```
Or: `corepack pnpm dev` (Turborepo runs everything). Open **http://localhost:3100**.

**Optional AI review:** install Ollama, `ollama pull qwen3:8b`, set `AI_PROVIDER=ollama`, restart API.

**Everything is free:** local crawler + local Ollama + DuckDuckGo/SearXNG. No paid keys anywhere.

---

## 9. Docker (infrastructure)

Docker provides the **database and queue** (and can run the whole stack). File: `docker-compose.yml`.

**Services**
| Service | Image / build | Purpose | Host port (this setup) |
|---------|---------------|---------|------------------------|
| `postgres` | `postgres:16-alpine` | main database (`clgsearch`) | **5433** → 5432 |
| `redis` | `redis:7-alpine` | BullMQ job queue | **6380** → 6379 |
| `api` | `apps/api/Dockerfile` | Fastify API | **4100** → 4000 |
| `crawler-worker` | `apps/crawler/Dockerfile` | crawl/parse workers | (no port) |
| `web` | `apps/web/Dockerfile` | Next.js dashboard | **3100** → 3000 |

Ports are configurable via `.env` (`POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, `API_PORT`, `WEB_PORT`).
We use **5433 / 6380 / 4100 / 3100** to avoid clashing with anything already on the defaults.

**Volumes:** `postgres_data`, `redis_data` (persist DB/queue), and `./storage` is bind-mounted into
`api` + `crawler` so screenshots/html/text/exports live on your disk.

**Ollama note:** Ollama runs on the **host**, not in Docker. Containers reach it via
`host.docker.internal`; the `extra_hosts: host-gateway` entries make that resolve on native Linux too
(already works on Docker Desktop for Windows/Mac).

**Common commands**
```bash
docker compose up -d postgres redis     # infra only (recommended in dev; run apps with pnpm)
docker compose up -d                     # full stack (build + run everything)
docker compose ps                        # status
docker compose logs -f api               # follow a service's logs
docker compose down                      # stop (keep data)
docker compose down -v                   # stop + delete data volumes
```

> **Tip:** In day-to-day development, run only `postgres` + `redis` in Docker and run the apps on the
> host with the `.bat` scripts (or `pnpm dev`) — faster reloads and easier debugging.

---

### Quick recap
- **What:** free, local, automatic discovery + validation of international-student **eligibility** *and*
  **scholarship** URLs (university **and** course level), exported to clean Excel/CSV and pushed to
  Aliff CRM — then kept **fresh** by the Change Monitor.
- **Stack:** TypeScript · Next.js/React/Tailwind/Framer Motion · Fastify/Zod · Crawlee/Playwright ·
  Prisma/Postgres · BullMQ/Redis · Ollama (local AI) · DuckDuckGo/SearXNG (free search) · Docker.
- **Promise:** every link is checked for reachability **and** real eligibility/scholarship content;
  levels never mixed; nothing silently missed (coverage reconciliation); no paid keys required.
- **Recurring value:** the **Change Monitor** re-checks exported URLs and flags NEW/CHANGED/BROKEN/FIXED,
  plus free website auto-discovery, backup/restore, and RAM auto-tune — so it stays useful year on year.
