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

## License & Sign-in

CLG Search is a **licensed, machine-bound** product with **team accounts** — it's built
to run once on a shared server while your whole team signs in from their own PCs.

1. **License** — the first time the dashboard opens with no valid license, it shows a
   lock screen with this machine's fingerprint and a box to paste a license key.
   Copy the fingerprint to your vendor; they send back a key; paste it and click
   Activate. See [docs/ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md) for the full flow
   (renewals, transferring to a new server, what each field on the License page means).
2. **First-run setup** — once licensed, if no accounts exist yet you'll be asked to
   create the administrator account (username, display name, password).
3. **Sign in** — after that, everyone signs in with their own account. Roles:
   **VIEWER** (read-only), **OPERATOR** (runs the pipeline), **ADMIN** (also manages
   settings, backups, team accounts, licensing, and the Aliff LIVE push).

Manage accounts from **Advanced → Team accounts** (ADMIN only).

---

## Dashboard Workflow

| Step | Page                 | Action                                                                                   |
| ---- | -------------------- | ---------------------------------------------------------------------------------------- |
| —    | Sign in              | Activate the license (first run only), then sign in with your team account               |
| 1    | Universities         | Upload universities using Excel / CSV or add them manually                               |
| 2    | Crawl & Validate     | Start the engine and crawl all — each URL is **crawled and validated inline** (single pass), validated links stream into the live feed |
| 3    | Revalidate           | One click: recheck reachability, remove broken (404) links, deduplicate, and write the FINAL files |
| 4    | Export & Aliff       | Build Aliff inputs, run Aliff auto-fill with your login (DRY-RUN first, then LIVE), and download files |

The dashboard also includes a Guide page, live crawl progress, ETA, the live **Validated URLs** feed, an
**Advanced** section (Review links, Criteria, Coverage, Change Monitor, Logs, Storage, License, Team accounts), settings, and
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
| Licensing & Auth | Node `crypto` (Ed25519, scrypt) | Machine-bound licensing + team login, no phone-home |
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

All important values can be controlled from the dashboard (ADMIN only):

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
  license/    Machine-bound license verification (Ed25519)
  shared/     shared types, schemas, URL tools
  queue/      BullMQ and Redis setup

tools/
  aliff-automation/   Playwright Aliff auto-fill module
  license-admin/      VENDOR ONLY — issues/inspects licenses

scripts/
  run-api.bat
  run-web.bat
  run-crawler.bat

setup.bat
start.bat
docker-compose.yml

storage/
  exports/    Validated Excel / CSV outputs
  license/    This install's activation state (never committed)
```

---

## Aliff Auto-fill Safety

The Aliff automation is designed with safety rules:

* Credentials are entered only for the current run
* Credentials are never stored
* DRY-RUN mode is enabled by default
* LIVE mode requires confirmation and an ADMIN account
* A save is counted only after real confirmation from the page
* University and course eligibility links are filled in separate Aliff sections
* Re-runs do not duplicate existing values

---

## Troubleshooting

| Issue                                        | Fix                                            |
| --------------------------------------------- | ---------------------------------------------- |
| API offline                                   | Run `start.bat` or `scripts\run-api.bat`       |
| Dashboard not loading                         | Start Docker Desktop and run `start.bat` again |
| Crawl not progressing                         | Start the crawler engine first                 |
| Browser count not changing                    | Restart the crawler engine                     |
| Large website timing out                      | Let the retry/watchdog system handle it        |
| Invalid license / License expired / Wrong machine | Contact your vendor with the fingerprint shown on the lock screen — see [docs/ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md) |
| Forgot admin password                         | See the offline recovery steps in [docs/ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md) |

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
