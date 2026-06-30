# CLG Search — International Eligibility URL Extractor

**CLG Search automatically discovers, validates, and exports university-level and course-level eligibility / criteria URLs for international-entry students — then prepares them for direct entry into the Aliff Super Admin CRM.**

It removes manual copy-paste work by crawling university websites, identifying admission and eligibility pages, validating every exported link, separating university and course records correctly, and generating clean Excel / CSV outputs.

## Core Purpose

CLG Search helps teams collect accurate eligibility URLs for international admissions.

* **University eligibility URLs** → Aliff **Manage Universities**
* **Course eligibility URLs** → Aliff **Manage Courses**
* University and course links are **never mixed**
* Broken or invalid links are removed before export
* Duplicate URLs are merged automatically
* Export files are ready for Aliff data entry or automation

---

## Quick Start

### Requirements

* Windows 10 / 11
* Node.js 20+
* Docker Desktop

### Steps

```text
1. Unzip the project anywhere.
2. Double-click setup.bat   first-time setup only
3. Double-click start.bat   every time you want to run the app
4. Open the dashboard at http://localhost:3100
```

`start.bat` starts PostgreSQL, Redis, the API server, and the web dashboard.
All scripts use relative paths, so the project can run on any PC without manual path editing.

---

## Dashboard Workflow

| Step | Page                 | Action                                                                                   |
| ---- | -------------------- | ---------------------------------------------------------------------------------------- |
| 1    | Universities         | Upload universities using Excel / CSV or add them manually                               |
| 2    | Crawl & Validate     | Start the engine and crawl all — each URL is **crawled and validated inline** (single pass), validated links stream into the live feed |
| 3    | Revalidate           | One click: recheck reachability, remove broken (404) links, deduplicate, and write the FINAL files |
| 4    | Export & Aliff       | Build Aliff inputs, run Aliff auto-fill with your login (DRY-RUN first, then LIVE), and download files |

The dashboard also includes a Guide page, live crawl progress, ETA, the live **Validated URLs** feed, an
**Advanced** section (Review links, Criteria, Coverage, Change Monitor, Logs, Storage), settings, and
status indicators.

---

## Tech Stack

| Layer            | Technology                  | Purpose                                         |
| ---------------- | --------------------------- | ----------------------------------------------- |
| Monorepo         | pnpm workspaces + Turborepo | Multi-app project structure                     |
| Dashboard        | Next.js 14 + Tailwind CSS   | Local web dashboard                             |
| API              | Fastify + Zod               | Backend control layer                           |
| Crawler          | Crawlee + Playwright        | Website crawling and browser-based validation   |
| Queue            | BullMQ + Redis              | Background job processing                       |
| Database         | PostgreSQL 16 + Prisma      | Storage for universities, URLs, snapshots, logs |
| Exports          | ExcelJS + fast-csv          | Excel / CSV output generation                   |
| Aliff Automation | Playwright                  | Safe auto-fill into Aliff CRM                   |
| Optional AI      | Ollama                      | Structured criteria text extraction when needed |

---

## Accuracy and URL Validation

CLG Search is designed to make sure that **100% of exported URLs are revalidated working URLs**.

The system uses multiple checks before a URL is exported:

1. **Crawl discovery**
   The crawler scans university websites using breadth-first crawling, link scoring, keyword detection, and page classification.

2. **Inline content validation (single pass)**
   As each page is crawled, its **text** is checked against the eligibility (evidence) / scholarship vocabulary right away — so a URL is only marked validated when the page genuinely proves entry-requirement / scholarship content, not just a keyword in the URL. Validated links stream into the live feed immediately.

3. **Network validation (Revalidate)**
   Every captured URL is rechecked using HEAD / GET requests with browser-like headers and redirect handling.

4. **Browser verification**
   URLs that cannot be confirmed through normal requests are opened in headless Chromium. If the page loads successfully, it is kept. If it fails, it is marked broken and excluded.

5. **Deduplication**
   Duplicate URLs are merged based on final canonical URL.

6. **Course / university separation**
   University-level eligibility pages and course-level eligibility pages are classified separately and exported into different files.

The result is a clean export containing only validated, deduplicated, working URLs.

---

## AI Usage

By default, CLG Search does **not** require AI.

The main deliverable is the **eligibility URL**, not the full parsed eligibility text. URL discovery and classification are handled using deterministic rule-based logic.

Default setting:

```text
AI_PROVIDER=none
```

Ollama is optional and useful only when structured criteria text is also required, such as:

* GPA requirement
* IELTS / TOEFL requirement
* Subject requirement
* Minimum marks
* Country-specific eligibility
* Entrance exam requirement

When enabled, Ollama extracts structured text from validated pages. If AI fails or times out, the system falls back to the rule-based parser.

---

## Settings

All important values can be controlled from the dashboard:

* Number of parallel browsers
* Maximum crawl pages
* Maximum crawl depth
* Crawl delay
* Minimum link score
* AI provider
* AI model
* AI temperature

Changes take effect after restarting the crawler engine from the Crawl page.

---

## Project Structure

```text
apps/
  web/        Next.js dashboard
  api/        Fastify API
  crawler/    Crawlee + Playwright workers

packages/
  database/   Prisma schema and repositories
  shared/     shared types, schemas, URL tools
  queue/      BullMQ and Redis setup

tools/
  aliff-automation/   Playwright Aliff auto-fill module

scripts/
  run-api.bat
  run-web.bat
  run-crawler.bat

setup.bat
start.bat
docker-compose.yml

storage/
  exports/    Validated Excel / CSV outputs
```

---

## Aliff Auto-fill Safety

The Aliff automation is designed with safety rules:

* Credentials are entered only for the current run
* Credentials are never stored
* DRY-RUN mode is enabled by default
* LIVE mode requires confirmation
* A save is counted only after real confirmation from the page
* University and course eligibility links are filled in separate Aliff sections
* Re-runs do not duplicate existing values

---

## Troubleshooting

| Issue                      | Fix                                            |
| -------------------------- | ---------------------------------------------- |
| API offline                | Run `start.bat` or `scripts\run-api.bat`       |
| Dashboard not loading      | Start Docker Desktop and run `start.bat` again |
| Crawl not progressing      | Start the crawler engine first                 |
| Browser count not changing | Restart the crawler engine                     |
| Large website timing out   | Let the retry/watchdog system handle it        |

---

## Default Ports

| Service    | Port |
| ---------- | ---- |
| PostgreSQL | 5433 |
| Redis      | 6380 |
| API        | 4100 |
| Dashboard  | 3100 |

---

## Final Output

CLG Search produces:

* Validated university eligibility URL files
* Validated course eligibility URL files
* Broken URL removal report
* Duplicate merge report
* Aliff-ready university input file
* Aliff-ready course input file

This creates a complete local workflow from university crawling to validated exports and Aliff CRM entry.
#   C R A W L  
 