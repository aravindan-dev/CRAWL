# Strict Crawl-Context Isolation (Eligibility ⊥ Scholarship)

## The problem

The system has two independent crawling objectives — **eligibility** (final
result: the main individual course/programme page URL) and **scholarship**
(final result: the scholarship page URL) — but the old engine ran them as one
mixed crawl. The `CRAWL_TARGET` setting only weighted the link **scorer**;
course-structure signals (+20 undergraduate, +15 courses, +15 same-domain, …)
still pushed cross-context URLs over the fetch threshold, so a scholarship
crawl happily fetched "Check eligibility" / course pages and vice versa.
Deliverables were then separated **after the fact** by URL-keyword filtering at
export time.

## The architecture

Every crawl execution now has exactly one immutable **crawl context**
(`ELIGIBILITY` | `SCHOLARSHIP`). `CRAWL_TARGET = "both"` runs **two separate
executions** per university — never one mixed crawl.

Every discovered URL passes a fixed conceptual order **before it may enter the
request queue**:

```
discover → normalize/canonicalize → dedupe → CLASSIFY → AUTHORIZE → score → queue → fetch
```

- **Classification** (`apps/crawler/src/discovery/urlClassifier.ts`) —
  deterministic, pre-fetch, never an LLM: URL structure + anchor text + the
  editable keyword vocabulary + the exporter's own course/scholarship URL
  patterns → a `PageClass` (COURSE_PAGE, COURSE_LISTING, ELIGIBILITY_PAGE,
  ADMISSIONS_PAGE, INTERNATIONAL_ADMISSIONS_PAGE, SCHOLARSHIP_PAGE,
  SCHOLARSHIP_LISTING, FUNDING_PAGE, NAVIGATION_PAGE, DOCUMENT, IRRELEVANT,
  UNKNOWN).
- **Authorization** (`apps/crawler/src/discovery/crawlAuthorization.ts`) — the
  policy gate. Each context may fetch its own target classes plus
  navigation/unknown discovery pages. Cross-context classes are refused with
  `crossContext: true`. **A high link score can never override this** — scoring
  runs only for already-authorized URLs.

Refused URLs are recorded as **`REJECTED_CROSS_CONTEXT`** discovered-link rows
(with `page_class` + reason) and create **zero network requests, zero
screenshots, zero artifacts, zero snapshots, zero parse jobs, zero exports**.

### Where the gate is enforced (every queue entry point)

`apps/crawler/src/crawl/runCrawl.ts`:

1. child-link discovery (incl. pagination links — same path),
2. the PDF→HTML course-page chase,
3. sitemap seeding (the "always seed course catalog" override is now
   eligibility-only),
4. resume/recovery frontier re-seeding (stale rows re-pass the gate),
5. a **defensive pre-navigation hook** — re-verifies the request's context and
   classification immediately before `page.goto`; violations abort with
   `noRetry` and are recorded as rejected (protects against stale/foreign
   queue entries),
6. **redirect safety** — after navigation the *final* URL is re-classified; a
   fetch that landed in the other context is discarded (no artifacts, no
   validation, no link harvesting, no snapshot).

### Context propagation

- `CrawlJobPayload`/`ParseJobPayload` carry `context`; BullMQ job ids are
  `crawl-<universityId>-<context>` (idempotent per context).
- `CrawlJob`, `DiscoveredLink`, `PageSnapshot` rows carry `crawl_context`
  (legacy rows default to `ELIGIBILITY`).
- `DiscoveredLink` uniqueness is `(university_id, url_hash, crawl_context)` so
  each context owns its crawl state; `resumeState` is context-scoped — one
  context's visits are never mistaken for the other's progress.
- Request `userData` carries `{context, pageClass, parentUrl}`.

## The validation engine

`apps/crawler/src/validation/validateTarget.ts` — target validation is
context-aware, two-staged and **explainable** (outcome + targetType + reasons +
evidence + confidence):

- **ELIGIBILITY**: (1) **course identity first** — URL classified as an
  individual course *and* content corroboration (degree award in title,
  structure/modules, duration/intake/facts); (2) only then course-level
  eligibility **evidence** (entry-requirement text, or a same-page
  entry-requirements anchor for modal/tab layouts). General
  admissions/eligibility/international/listing pages are **DISCOVERY_ONLY** —
  fetchable to find links, never final results, no matter how many keywords
  they contain.
- **SCHOLARSHIP**: individual scholarship page (shared precision filters:
  blog/fees/listing/login are not records) + scholarship content evidence.
  Listings/funding pages are discovery-only.

Outcomes: `VALIDATED_TARGET` (exportable) / `DISCOVERY_ONLY` / `REJECTED`.
`content_verified` now means "validated target of the active context".

**Snapshots + parse jobs are created only for validated individual course
targets of an eligibility crawl** — the course-criteria parser never receives
general admissions pages, listings, or scholarship pages. `parseWorker` and
`runParse` both re-check context defensively.

## Anchors are secondary metadata

The entry-requirements anchor (`#entry-requirements` etc.) never creates a
crawl target, never triggers a fetch, and **never replaces the main course
URL**. The primary/exported URL is the main course page (fragments are stripped
by canonicalization, so anchor variants collapse to one course). The deep-link
is stored in `discovered_link.eligibility_url` and exported as an additive
last column `eligibility_anchor_url`.

## Revalidation & exports (final safety gates only)

- `recheck.ts` (course/university deliverables): reads only
  non-SCHOLARSHIP-context, non-rejected rows; scholarship page classes are
  excluded defensively; ships the main course URL as primary + anchor column.
- `scholarshipService.ts`: reads SCHOLARSHIP-context rows (legacy fallback:
  scans old context-less data until the first context-aware crawl); course/
  eligibility page classes can never ship.
- `linkValidationService`: `REJECTED_CROSS_CONTEXT` is terminal — even manual
  re-validation never fetches those URLs.

## Verification

- `pnpm -r test` — 97 tests green, including
  `discovery/crawlAuthorization.test.ts` and
  `validation/validateTarget.test.ts` covering the 11 required scenarios.
- `apps/crawler/src/verify-context-isolation.ts` — end-to-end proof: a local
  fake university site + the REAL crawl engine (Playwright), run once per
  context, recording every HTTP request the site receives. Scholarship crawl:
  0 requests to eligibility/course URLs (15 rejected pre-fetch); eligibility
  crawl: 0 requests to scholarship URLs; exactly one snapshot (the validated
  course page). Run: `tsx src/verify-context-isolation.ts` (needs
  Postgres + Redis).

## Observability

Structured crawl logs show: crawl start (context), per-page validation
decisions (`<status> · <pageClass> · <outcome> — <reason>`),
`fetch-rejected(cross-context)` events (pre-fetch, redirect, and
pre-navigation-guard variants), and a final per-crawl summary:
`discovered / authorized / crossContextRejected (0 network requests each) /
fetched / validatedTargets / discoveryOnly`. The same counters are persisted in
`CrawlJob.stats`.
