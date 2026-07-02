# Deterministic University Crawler — Redesign Architecture

**Role basis:** Principal Web Crawling Architect / Search Infrastructure Engineer / Data Quality Specialist
**Target system:** CLG Search (this repository — Crawlee/Playwright crawler, Prisma/Postgres, BullMQ, Next.js dashboard)
**Goal:** near-perfect coverage + bit-identical results across repeated crawls of an unchanged site, at a scale of thousands of universities.

---

## 0. The Two Laws this design is built on

1. **Coverage law** — every course URL that exists on a site must end the crawl in exactly one of these states:
   `VALIDATED | DUPLICATE_OF(x) | NOT_A_COURSE(reason) | DEAD(status) | QUARANTINED(transient)`.
   *Zero unexplained URLs.* If a URL was seen by any discovery source and has no terminal state, the crawl is not finished.

2. **Determinism law** — the delivered dataset must be a **pure function of (site content, config manifest)**.
   `dataset = F(siteContent, manifest)` — never a function of time, machine, network speed, worker count, or crawl order.
   Everything below exists to enforce one of these two laws.

---

## 1. Gap analysis — where the CURRENT system breaks the laws

| # | Current behavior (file) | Law broken | Why |
|---|---|---|---|
| G1 | Wall-clock budget `MAX_CRAWL_MINUTES` aborts the crawl (`runCrawl.ts` deadline/`budgetTimer`) | Both | Pages visited depends on network speed that day → different runs visit different subsets |
| G2 | `waitForTimeout(600)` + `networkidle` heuristics + "load more" click loops (`runCrawl.ts`) | Determinism | JS-rendered links appear or don't depending on timing → link set varies |
| G3 | Crawlee autoscaled pool + forefront enqueues + `retireBrowserAfterPageCount` | Determinism | Visit order and browser state differ per run; only harmless if outputs are strictly set-based (today they are not: `content_verified` depends on visit) |
| G4 | `decide()` in `recheck.ts` classifies from a single live fetch; one retry | Determinism | A transient 403/timeout flips a row between WORKING/UNCONFIRMED/BROKEN run-to-run |
| G5 | No previous-run memory: every recheck starts from zero | Determinism | A temporarily-down page is dropped this run, present next run → counts fluctuate |
| G6 | `localeCompare` used for all export ordering (`recheck.ts`, `crawlAdminService.ts`) | Determinism | Locale/ICU-version dependent → different order on different OS/node builds |
| G7 | Keyword vocabulary editable at runtime (`getKeywords()`), unversioned | Determinism | Dataset changes without a site change and without a traceable cause |
| G8 | LLM (Ollama qwen3) extracts course criteria live | Determinism | LLMs are not bit-stable; re-parsing unchanged content can give different fields |
| G9 | No content fingerprinting; revalidation = re-fetch everything | Both | Cannot distinguish UNCHANGED/UPDATED/MOVED; wasteful; timing-sensitive |
| G10 | Anchor detection (`fetchHtml`) uses plain fetch; WAF-blocked sites yield 0 anchors some runs | Determinism | Deep-links appear/disappear depending on WAF mood |
| G11 | Screenshot/artifact side-effects mixed into the validation path | — | Slows the critical path; failures pollute crawl outcomes |
| G12 | Export timestamps via `toLocaleString()` inside data files | Determinism | Machine timezone leaks into deliverables (currently confined to Summary sheet — keep it that way, or move to ISO-8601 UTC) |

---

## 2. Architecture overview

Replace the single "crawl → recheck" pipeline with **seven pure stages**, each writing content-addressed, idempotent records. Any stage can be re-run and must produce identical output for identical input.

```
            ┌────────────────────────────────────────────────────────────────┐
            │                        CONFIG MANIFEST                         │
            │  code version + vocab version + ruleset version + env pins     │
            │  manifest_hash = sha256(all of the above)                      │
            └───────────────┬────────────────────────────────────────────────┘
                            │ (stamped on every record + every export)
 ┌──────────┐   ┌───────────▼──────────┐   ┌──────────────┐   ┌─────────────┐
 │ 1.CENSUS │──▶│ 2.ACQUIRE            │──▶│ 3.EXTRACT    │──▶│ 4.CANONICAL │
 │ discover │   │ fetch ladder + render│   │ links, text, │   │ URL + course│
 │ ALL URLs │   │ to fixed point       │   │ JSON-LD, meta│   │ key mapping │
 └──────────┘   └──────────────────────┘   └──────────────┘   └──────┬──────┘
      ▲                                                              │
      │            frontier closure loop (until no new URLs)         │
      └──────────────────────────────────────────────────────────────┘
                            │ frontier empty = census complete
 ┌──────────────┐   ┌───────▼───────┐   ┌───────────────┐   ┌───────────────┐
 │ 7.AUDIT +    │◀──│ 6.DIFF /      │◀──│ 5.CLASSIFY +  │──▶│ 5b.ASSOCIATE  │
 │ EXPORT       │   │ REVALIDATE    │   │ VALIDATE      │   │ eligibility + │
 │ (sorted, set)│   │ state machine │   │ (confidence)  │   │ scholarship   │
 └──────────────┘   └───────────────┘   └───────────────┘   └───────────────┘
```

**Key structural change vs today:** discovery runs to **frontier closure** (queue empty), not to a wall clock. The page-visit budget, if one must exist, is expressed in **pages** (deterministic) and applied to a **deterministically ordered frontier**, so the same subset is chosen every run. Validation/classification then operates on the census — never on "whatever we reached in 40 minutes".

---

## 3. Deterministic crawling algorithms

### 3.1 Frontier with total ordering

The frontier is a persistent priority queue whose pop order is a **pure function of its contents** — never of insertion order, worker count, or timing.

```
FrontierKey = (tier ASC, score DESC, canonical_url ASC-codepoint)

tier:  0 = seed / sitemap census
       1 = eligibility & admission hubs        (score ≥ 60)
       2 = course/programme pages              (40–59)
       3 = section pages leading to courses    (20–39)

pop(): SELECT ... FROM frontier
       WHERE state = 'PENDING'
       ORDER BY tier, score DESC, canonical_url    -- codepoint collation (Postgres "C")
       LIMIT batch FOR UPDATE SKIP LOCKED
```

- Workers may run in parallel: parallelism affects only *when* a URL is fetched, never *whether* or *how its outcome is recorded*, because all downstream stages are set-based.
- `SKIP LOCKED` + idempotent upserts make N workers produce the same closure as 1 worker.
- **Sorting rule everywhere:** binary codepoint comparison (`ORDER BY ... COLLATE "C"` in Postgres, `a < b ? -1 : a > b ? 1 : 0` in TS). **`localeCompare` is banned from every data path** (fix G6).

### 3.2 Time is a TARGET, pages are the only cap (decision: 2026-07-02)

`MAX_CRAWL_MINUTES` is a **soft performance target**, never a guillotine: the crawl
always runs to frontier closure; exceeding the target only logs a notice. Speed to
meet the target comes from § 16 (mutation-quiet settle, fetch ladder, fast-fail
timeouts, caching) — not from dropping pages.

If a hard bound is ever unavoidable, it must be a **page count** applied to the
deterministically ordered frontier:

```
eligible = frontier sorted by FrontierKey
visit exactly the first N — N is config, order is deterministic
⇒ same N pages chosen every run on an unchanged site
```

Tiering guarantees such a cap could never cost a course page before it costs a marketing page.

### 3.3 Deterministic retry policy

```
attempt schedule (fixed): t+0s, +5s, +25s   (3 attempts max, fixed backoff, no jitter*)
classify after final attempt:
  2xx/3xx→content        → FETCHED
  404/410                → DEAD_GONE
  403/401/429            → BLOCKED   (candidate for browser escalation, then hysteresis)
  5xx/timeout/reset      → TRANSIENT (→ QUARANTINE, § 8.3 — never silently dropped)
```

\* Jitter is an anti-thundering-herd tool; per-host politeness delay already serves that purpose here.

### 3.4 Render-to-fixed-point (fix G2)

JS pages are rendered until extraction is **stable**, replacing sleep-based waits:

```
function renderFixedPoint(page, url, K = 3):
    prev = null
    for i in 1..K:
        html_i  = render(page, url)          # domcontentloaded + mutation-quiet 500ms (max 8s)
        links_i = extractLinkSet(html_i)     # SET of canonical URLs (order-free)
        if links_i == prev: return (html_i, links_i, stable=true)
        prev = links_i
        expandDynamic(page)                  # deterministic action script (§3.5)
    return (html_K, UNION(links_1..K), stable=false)   # union of sets = order-independent
```

- Two consecutive identical extractions ⇒ the page is proven stable.
- If never stable (rotating widgets), the **union of link sets** is taken — a set union is commutative, so the result is still deterministic, and volatile links are filtered later by classification.

### 3.5 Deterministic dynamic-content expansion

Replace the heuristic click loop with an ordered **action script** executed identically every run:

```
1. select all  <select name$="_length">        → set to max/All, dispatch change
2. click ALL buttons matching /load more|show more|view all/i
     in DOM document order, max 20 clicks, waiting for mutation-quiet after each
3. scroll to bottom in fixed 4-viewport steps, mutation-quiet between steps
4. enumerate pagination: rel=next, .pagination a[href], ?page=N — follow as
     frontier URLs (crawled like any page), NOT via in-page clicking
```

Pagination-as-URLs (step 4) moves the nondeterminism of infinite scroll into the deterministic frontier.

### 3.6 Browser environment pinning

| Variable | Pin |
|---|---|
| Browser | Playwright-bundled Chromium, exact version from lockfile |
| Viewport | 1366×900 fixed |
| UA | one fixed realistic Chrome string (config, versioned in manifest) |
| Locale / TZ | `en-US`, `TZ=UTC` for the crawler process |
| `Accept-Language` | `en` |
| Animations | `prefers-reduced-motion: reduce` + CSS animation disable |
| Blocked resources | images, media, analytics (fixed blocklist, versioned) |

---

## 4. URL normalization (canonicalization algorithm)

One logical page ⇒ exactly one canonical URL. Two layers:

### 4.1 Generic URL canonicalization (`packages/shared/url/canonicalize.ts` — extend)

```
function canonicalize(raw):
    u = parse(raw); if fail → REJECT(malformed)
    u.scheme   = "https" if site serves https else keep
    u.host     = lowercase, strip default port, resolve www-alias by site probe
                 (probe result cached per host, versioned in manifest)
    u.path     = percent-decode unreserved chars → re-encode reserved consistently;
                 collapse //; resolve /./ and /../; strip trailing slash (except root);
                 LOWERCASE only if site is case-insensitive (probe: /PATH vs /path same content)
    u.query    = drop tracking params (utm_*, gclid, fbclid, mc_*, _ga, ref, source);
                 drop session params (PHPSESSID, jsessionid, sid, cfid, cftoken);
                 sort remaining params by key codepoint; drop if empty
    u.fragment = strip (fragments are re-attached later ONLY as eligibility anchors)
    return u.toString()
```

### 4.2 Redirect + `<link rel=canonical>` resolution

```
final = follow redirects (≤5) from canonicalize(raw)
if page has <link rel=canonical> AND canonical is same registrable domain
   AND canonical page returns 2xx  → final = canonicalize(canonical)
record alias edge: raw → final    (all aliases kept for provenance/diffing)
```

### 4.3 Course-key canonicalization (exists: `courseUrl.ts` — keep, formalize)

```
courseKey(url):
    strip year/intake segments  (/2026, /years/…)
    collapse .pdf prospectus → its HTML page
    collapse /international/courses/x ↔ /courses/x       (variant of same course)
    key = registrableDomain + canonical path
```

`courseKey` is the primary key of the course dataset — it is what makes counts stable across cosmetic URL churn.

---

## 5. Discovery engine (census)

Every source below is an independent producer feeding the same frontier; each discovered URL records its **provenance set** (which sources found it).

| Source | Method |
|---|---|
| XML sitemaps + indexes | via real browser (WAF-proof, already implemented); nested indexes; alternate subdomains (`study.`, `courses.`, `handbook.`, …) |
| robots.txt | `Sitemap:` lines on all catalog subdomains |
| HTML sitemaps | pages matching `/sitemap`, `/site-map`, `/a-z` |
| Navigation / mega-menus | extract `<nav>`, `[role=navigation]`, header/footer links **including hidden** (`display:none` submenus — extract from DOM, not from visibility) |
| Faculty / department / school pages | tier-3 section crawl |
| Course finders & degree finders | § 3.5 action script + pagination-as-URLs |
| A–Z indexes | enumerate every letter page `?letter=A..Z` deterministically |
| Internal search | probe with fixed query list: degree levels + faculty names discovered on-site (sorted, capped) |
| Pagination | rel=next + `?page=N` synthesis until first empty page |
| Breadcrumbs / related courses | extracted as normal links |
| JSON-LD / schema.org | `ItemList`, `Course`, `sitelinks` — parsed from every fetched page |
| Embedded state | `__NEXT_DATA__`, `window.__NUXT__`, `INITIAL_STATE` JSON blobs — walk for URL-shaped strings under same domain |
| XHR/API sniffing | record JSON API responses during render; walk for URLs; replay APIs directly next run (faster + more deterministic than DOM) |
| GraphQL | if `/graphql` responds to introspection publicly, enumerate course queries (read-only) |
| RSS/Atom | `<link type=application/rss+xml>` |
| URL prediction | (exists: `coverageService.predictUrls`) pattern-mine validated course URLs → generate candidate URLs for gaps → verify by fetch; only VERIFIED predictions enter the dataset |

**Census completeness rule:** discovery repeats until an iteration adds **zero new canonical URLs** (closure). This replaces the time budget as the notion of "done".

### 5.1 Source reconciliation (false-negative prevention)

```
for each canonical URL:
    provenance ⊆ {sitemap, nav, finder, atoz, search, jsonld, api, predicted, linkgraph}

alarms (reported in audit, § 12):
  • sitemap-only URLs unreachable from link graph  → "orphan pages" (still crawled)
  • link-graph course URLs missing from sitemap    → "sitemap gaps"
  • faculty with 0 validated courses               → "faculty coverage hole"
  • degree level present in nav but 0 courses      → "degree coverage hole"
```

---

## 6. Course classification (multi-signal, deterministic)

A page is a course iff its **classification score** clears threshold. All signals are rule-based, weights fixed and versioned in the manifest.

| Signal | Weight | Example |
|---|---|---|
| URL under catalog path + specific segment (`isRealCourse`) | +30 | `/courses/bachelor-nursing` |
| JSON-LD `@type: Course` / `EducationalOccupationalProgram` | +30 | |
| H1/title contains award pattern (`Bachelor|Master|PhD|Diploma|Certificate…`) | +15 | |
| Breadcrumb trail contains Courses/Study | +10 | |
| Page has ≥2 of: duration, fees, intake, entry-requirements blocks | +15 | |
| Course code pattern (CRICOS/UCAS/internal `[A-Z]{2,6}\d{1,4}`) | +10 | |
| **Negative:** news/event/staff/policy/blog URL or breadcrumb | −100 | hard reject list (exists: `COURSE_DENY`, `ADMIN_PROCESS`) |
| **Negative:** listing/finder page shape (>30 course links, no own metadata) | −50 | |

```
score ≥ 50  → COURSE
25 ≤ s < 50 → COURSE_CANDIDATE  (needs 2nd independent signal source: e.g. sitemap AND jsonld)
score < 25  → NOT_A_COURSE(top reason)
```

---

## 7. Validation engine (confidence, not pass/fail)

Each validated course row carries a **field-by-field confidence vector**, aggregated to a course confidence and to dataset-level confidence (§ 12).

```ts
interface ValidationResult {
  course_key: string;
  verdict: "VALID" | "VALID_LOW" | "REJECTED";
  confidence: number;              // 0..1, deterministic weighted sum
  signals: {                       // each: { present: boolean, value?, source, weight }
    url_pattern; title_award; h1_match; canonical_ok; breadcrumbs;
    jsonld_course; duration; fees; entry_requirements_block;
    course_code; degree_level; study_mode; campus; intake;
    eligibility_url; scholarship_url;
  };
  reachability: "HTTP_2XX" | "BROWSER_2XX" | "BROWSER_RENDERED" | "QUARANTINED";
}
```

**Reachability ladder (replaces single-fetch `decide()`, fixes G4/G10):**

```
1. HTTP GET, browser headers        → 2xx? HTTP_2XX
2. real-browser navigation          → 2xx? BROWSER_2XX
3. rendered despite odd status?     → content checks:
      auth/SSO redirect or error stub  → DEAD_GATED
      ≥300 chars real content          → BROWSER_RENDERED
4. all transient failures           → QUARANTINED (hysteresis, § 8.3)
```

Every step of the ladder runs **through the browser for WAF sites** — including anchor detection (fix G10: `entryRequirementAnchor` must receive browser-fetched HTML when plain fetch returns empty/403).

---

## 8. Revalidation engine (deterministic diffing)

### 8.1 Fingerprints (computed at extract time, stored per snapshot)

```
content_hash  = sha256( normalizeContent(html) )
meta_hash     = sha256( canonical JSON of extracted metadata fields, keys sorted )
links_hash    = sha256( sorted set of canonical outbound links )
elig_hash     = sha256( eligibility_url + normalized entry-requirements text )
sch_hash      = sha256( sorted associated scholarship URLs )

normalizeContent(html):
    parse → remove: <script> <style> <noscript> comments,
                    cookie/consent banners (fixed selector list, versioned),
                    csrf tokens, nonces, build ids, timestamps, session ids,
                    rotating hero/banner containers (fixed selector list)
    text = visible text, whitespace collapsed, NFC unicode normalization
    return text
```

Only `meta_hash`/`elig_hash`/`sch_hash` changes count as **academic changes**. `content_hash` alone changing (e.g. redesign) triggers UPDATED only if extraction also changed — CSS/JS/analytics churn is invisible by construction.

### 8.2 State machine (per course_key, comparing run N-1 → N)

```
                     found this run?
                    ┌──── yes ────────────────────────┐        ┌── no ──┐
                    ▼                                 ▼        ▼        ▼
             same canonical URL?                 new key   reachable last run?
             ┌─ yes ─┐      ┌─ no ─┐                │        ┌─ no →  (stay REMOVED)
             ▼       ▼      ▼      ▼                ▼        ▼
        meta_hash  hashes  301?  content_hash    NEWLY    consecutive_miss += 1
        equal?     diff    │     matches old      ADDED      │
        │ yes      │ yes   ▼     key elsewhere?              ▼
        ▼          ▼      REDIRECTED  │ yes            miss < R? → TEMP_UNAVAILABLE
     UNCHANGED  UPDATED               ▼                miss ≥ R? → PERMANENTLY_REMOVED
                                    MOVED                         (R = 3 runs, config)
```

### 8.3 Hysteresis / quarantine (fixes G5 — the #1 cause of count fluctuation)

- A course that was VALID in run N-1 and hits a **transient** failure in run N keeps its last-known-good record, flagged `QUARANTINED (run 1 of R)`. It ships in the deliverable with `validity=CARRIED_FORWARD`.
- Only **R consecutive** hard-dead results (404/410/gone-from-all-sources) remove it.
- Result: transient network noise can never change the course count. Counts change only when `meta/elig/sch` hashes or the census genuinely change.

### 8.4 Conditional revalidation (performance)

- Send `If-None-Match`/`If-Modified-Since` from stored ETag/Last-Modified → a `304` short-circuits to UNCHANGED with zero parsing.
- Content-addressed extraction cache: `extraction = cache[content_hash]` — unchanged pages are **never re-extracted and never re-sent to the LLM** (fixes G8: LLM output is frozen per content version; temperature=0 + pinned model + schema-validated output for first-time extraction only, with rule-based extractors taking precedence).

---

## 9. Eligibility URL detection (cascade)

For every course, evaluate in fixed order — first hit wins; each level carries a fixed confidence:

```
1. on-page entry-requirements section anchor      → course_url#anchor      (conf 1.00)
   (entryRequirementAnchor over BROWSER-fetched HTML)
2. per-course requirements subpage                → …/entry-requirements   (conf 0.95)
   (link text/urls: entry|admission|eligibility|academic|english|ielts|language requirements)
3. requirements tab/modal fragment in page JS     → course_url#modal-id    (conf 0.90)
4. international variant of the course page       → /international/…#…     (conf 0.85)
5. faculty/department admission requirements page                          (conf 0.60)
6. university-wide international entry-requirements page (main URL)        (conf 0.50)
```

- Level 6 is chosen by the existing `MAIN_UNI_PREF` ranking (`recheck.ts`) — keep, but rank on codepoint-sorted candidates for tie-break determinism.
- Language/IELTS requirement pages found at any level attach as a secondary `language_requirements_url`.
- Coverage metric: `% of courses with eligibility conf ≥ 0.85` (§ 12).

## 10. International scholarship association

Two-part strategy: **collect** (precision-filtered census of scholarship records — exists: `scholarshipFilters.ts`) then **associate** (deterministic specificity ladder):

```
candidates = all validated scholarship records for the university
for each course, pick ALL matches at the MOST SPECIFIC level that matches:

  L1 course-specific     scholarship page names the course / links to course URL   (conf 1.00)
  L2 department-level    scholarship page under course's department path/name      (conf 0.85)
  L3 faculty-level       faculty name/path match                                   (conf 0.75)
  L4 degree-level        UG/PG/research-specific international scholarship         (conf 0.65)
  L5 university-wide     international scholarships hub + automatic/merit lists    (conf 0.50)

international filter: page text/URL must match international|overseas|全球|EU/EEA…
                      OR be a general merit/automatic award with no domestic-only marker
matching is string/URL-rule based; all rule lists versioned in the manifest
```

Precision guardrails (already implemented, keep): container/listing pages, blog/Insight articles, fee pages, login/auth, external aggregators are **never** scholarship records.

---

## 11. Required-field extraction (deterministic extractor ladder)

Per field, sources tried in fixed order; first present source wins; source recorded:

| Field | Source order |
|---|---|
| title | JSON-LD name → H1 → `<title>` (cleaned) → URL slug (award-checked — exists) |
| course code | JSON-LD identifier → CRICOS/UCAS labeled value → code pattern in H1/URL |
| faculty / department | breadcrumbs → JSON-LD provider/department → nav section → URL path segment |
| degree level | award word in title/H1 → URL slug → JSON-LD educationalCredentialAwarded |
| duration | labeled row (`Duration|Length`) → JSON-LD timeToComplete → regex `\d+(\.\d+)? (year|month|semester)s?` |
| study mode | labeled row → fixed vocab {full-time, part-time, online, blended, distance} |
| campus | labeled row → JSON-LD location → campus vocab discovered from site (sorted) |
| intake | labeled row (`Intake|Start date|Commencing`) → month/season vocab |
| tuition fees | international-fee labeled row → JSON-LD offers → currency+amount regex (record raw string + parsed { amount, currency, period }) |
| entry requirements | § 9 URL + normalized text extract of the section |

All regex/vocab lists are part of the versioned ruleset. LLM is a **last-resort filler** for fields the ladder missed, gated by the content-addressed cache (§ 8.4) so it can never introduce run-to-run variance on unchanged pages.

---

## 12. Coverage verification & confidence report

```
CourseDiscoveryConfidence =
    1 − (unexplained_urls + failed_census_sources_weight + coverage_holes_weight)

per-source recall check:  |validated ∩ source| / |validated|   for each discovery source
   → a source that "sees" <70% of validated courses on a site type it should cover flags a gap

EligibilityURLConfidence  = Σ course elig confidences / |courses|
ScholarshipURLConfidence  = Σ course sch confidences  / |courses|
OverallCrawlConfidence    = weighted min(discovery, validation, eligibility, scholarship)
                            (min, not mean — a chain is as strong as its weakest link)
```

Faculty/degree coverage: every faculty and degree level discovered in nav/sitemap must own ≥1 validated course or a documented reason (e.g. "research-only institute").

---

## 13. Crawl audit report (schema)

Written per run as `storage/audits/<university>/<run_id>.json` + one human sheet:

```jsonc
{
  "run_id": "…", "university": "…", "manifest_hash": "…",
  "started_utc": "…", "finished_utc": "…",
  "census":   { "urls_seen": 0, "candidates": 0, "duplicates_removed": 0,
                "redirects": 0, "js_rendered": 0, "render_unstable": 0,
                "failed": 0, "retries": 0, "quarantined": 0,
                "by_source": { "sitemap": 0, "nav": 0, "finder": 0, "...": 0 } },
  "courses":  { "validated": 0, "low_confidence": 0, "rejected": 0,
                "new": 0, "updated": 0, "moved": 0, "redirected": 0,
                "temp_unavailable": 0, "removed": 0, "carried_forward": 0 },
  "eligibility": { "found": 0, "by_level": {"anchor":0,"subpage":0,"tab":0,"intl":0,"faculty":0,"university":0},
                   "missing": ["course_key…"] },
  "scholarships": { "records": 0, "associated": 0,
                    "by_level": {"course":0,"department":0,"faculty":0,"degree":0,"university":0},
                    "missing": ["course_key…"] },
  "confidence": { "discovery": 0.0, "validation": 0.0,
                  "eligibility": 0.0, "scholarship": 0.0, "overall": 0.0 },
  "dataset_hash": "sha256 of the sorted, serialized deliverable"   // ← the determinism proof
}
```

`dataset_hash` equality between two runs **is** the reproducibility test.

---

## 14. Data structures (core)

```ts
interface ConfigManifest {
  code_version: string;          // git SHA
  ruleset_version: string;       // hash of all regex/vocab/selector lists
  vocab_version: string;         // hash of keyword sets (fix G7 — vocab edits bump this)
  browser: { name: "chromium"; version: string; viewport: [1366, 900]; ua: string };
  env: { tz: "UTC"; locale: "en-US"; collation: "codepoint" };
  limits: { max_pages: number; retries: [0, 5, 25]; removal_hysteresis_runs: 3 };
  manifest_hash: string;
}

interface FrontierEntry {
  canonical_url: string;         // PK with university_id
  tier: 0 | 1 | 2 | 3;
  score: number;
  provenance: SourceFlag[];      // bitset of discovery sources
  state: "PENDING" | "FETCHED" | "DEAD_GONE" | "DEAD_GATED" | "BLOCKED" | "QUARANTINED";
  attempts: number;
  aliases: string[];             // raw URLs that canonicalized here
}

interface PageRecord {
  canonical_url: string;
  http_status: number | null;
  reachability: Reachability;
  content_hash: string; meta_hash: string; links_hash: string;
  etag?: string; last_modified?: string;
  render_stable: boolean;
  extracted: ExtractedPage;      // cached by content_hash (content-addressed)
}

interface CourseRecord {
  course_key: string;            // PK — canonical course identity (§4.3)
  canonical_url: string;
  fields: RequiredFields;        // title, code, faculty, department, level, duration,
                                 // mode, campus, intake, fees, entry_req_text
  field_sources: Record<keyof RequiredFields, FieldSource>;
  eligibility: { url: string; level: EligLevel; confidence: number };
  language_requirements_url?: string;
  scholarships: { url: string; level: SchLevel; confidence: number }[];
  validation: ValidationResult;
  diff_state: "UNCHANGED"|"UPDATED"|"MOVED"|"REDIRECTED"|"NEW"|"TEMP_UNAVAILABLE"|"REMOVED";
  carried_forward: boolean;      // quarantine hysteresis marker
  first_seen_run: string; last_confirmed_run: string; consecutive_misses: number;
}
```

---

## 15. Failure recovery

| Failure | Strategy |
|---|---|
| Crawler crash mid-run | DB-backed frontier = resume exactly (exists); all writes idempotent upserts keyed by canonical_url |
| Browser OOM (0xC0000409) | retire-per-N-pages (exists) + watchdog restart (exists) — safe because pop order is DB-defined, not process-defined |
| Site-wide WAF block mid-crawl | whole-host circuit breaker → all pending host URLs → QUARANTINED; run marked `partial`; hysteresis protects the previous dataset; **a partial run never overwrites deliverables** (export gate: census closure must be reached) |
| Export interrupted | write `file.tmp` → fsync → atomic rename; consumers never see torn files |
| Parse/LLM outage | fields fall back to ladder-extracted values; LLM fill queued for next run; missing-field list in audit |
| DB restore/reset | manifest + run_id stamped on every record → mixed-run data detectable and rejected by export gate |

---

## 16. Performance without coverage loss

1. **HTTP-first fetch ladder** — most pages need no browser; escalate per-URL only on failure/JS-dependence (learned per host, persisted).
2. **Conditional GETs + content-addressed extraction cache** — an unchanged site costs ~1 header round-trip per page on revalidation; the expensive extract/validate/LLM path runs only for new content hashes.
3. **API replay** — where XHR sniffing found a JSON course API, subsequent runs hit the API directly (cheaper AND more deterministic than DOM).
4. **Per-host fixed concurrency + global worker pool** — parallelism scales across universities (safe: outputs are set-based), politeness per host is fixed config.
5. **Browser reuse with hard page-count recycling** — flat memory (exists).
6. **Batched DB writes** (exists: `createManyDiscovered`).
7. Artifact side-work (screenshots) moved **off the critical path** to a post-validate queue (fix G11).

---

## 17. Edge-case catalog

| Case | Handling |
|---|---|
| Course only as PDF | collapse to HTML page; PDF kept as `pdf_fallback` only if no HTML page reachable (exists) |
| Course behind auth/SSO (CSU policing case) | DEAD_GATED — never shipped; recorded in audit `missing` with reason |
| Year/intake URL variants | courseKey collapse (exists) |
| Domestic + international variants | collapse to one key; prefer `/international/` URL for the deliverable (exists) |
| Same course on two subdomains | alias edges + content-hash MOVED detection pick one canonical |
| Rotating "featured courses" widgets | excluded from normalizeContent; links still discovered but classification-gated |
| Infinite calendar/faceted URLs | query canonicalization + facet-param blocklist + per-pattern URL cap with codepoint-sorted selection |
| Soft-404s ("Page not found", HTTP 200) | classified DEAD by title/content stub rules (exists: JUNK_NAME/BLOCKED_PAGE — extend to census stage) |
| Mixed-language sites | crawl `en` paths; record `source_language`; non-EN courses kept if site has no EN variant |
| A/B-tested pages | normalizeContent + meta-hash comparison absorbs template variants; render fixed-point takes stable extraction |
| Geo-personalized content | fixed crawl origin + `Accept-Language: en`; note in audit if geo markers detected |

---

## 18. Migration plan for THIS repo (phased, each phase shippable)

**Phase 1 — determinism quick wins** ✅ IMPLEMENTED 2026-07-02
1. ✅ `codepointCompare` in `@clg/shared/determinism.ts`; all data-path `localeCompare` replaced (recheck, finalize, export-by-university, crawlAdminService) (G6).
2. ✅ `vocabHash()` — effective-vocabulary hash stamped in exports, audits, state files (G7).
3. ✅ Quarantine/hysteresis in `recheck.ts`: transient failures (`UNREACHABLE`/null-status) carry the last-known-good row via `storage/state/recheck-<level>.json`; dropped only after `MAX_MISSES=3` consecutive misses. CONFIRMED dead (`GONE`/`GATED`/`STUB`/`LISTING`) still drops immediately — precision beats persistence (G5).
4. ✅ Anchor detection pass 2 through a real browser (`page.content()` = rendered DOM) when plain fetch is WAF-blocked (G10).
5. ✅ `datasetHash()` printed per run, stamped in the Excel Summary, written to `storage/audits/recheck-<level>-<runid>.json` (§ 13).

**Phase 2 — census & frontier** ✅ CORE IMPLEMENTED 2026-07-02
6. ✅ Wall-clock abort removed — crawl runs to frontier closure; `MAX_CRAWL_MINUTES` is a soft target (G1). Full DB-ordered frontier (`ORDER BY tier, score, url COLLATE "C"`) remains future work — outputs are set-based so visit order no longer affects the dataset.
7. ✅ Mutation-quiet settle replaces the fixed 600ms sleep; finder pages get a link-count fixed-point loop (G2). Full two-render extraction compare remains future work.
8. ✅ Content fingerprints (`content/meta/links` hashes over normalized text) per crawled page → `storage/state/fingerprints/<universityId>.json`, merged on resume, atomic writes (G9 groundwork).

**Phase 3 — diff engine & cache** ✅ CORE IMPLEMENTED 2026-07-02
9. ✅ Diff state machine in recheck (NEW/UNCHANGED/UPDATED/CARRIED/REMOVED vs previous run, logged + audited); conditional GETs via stored ETag/Last-Modified (304 → WORKING with zero download) (G9). Content-addressed LLM extraction cache remains future work (G8 — mitigated today because parse only runs on newly crawled snapshots).
10. ✅ Audit JSON per run (counts, diff, dataset_hash, vocab). Full per-field confidence vectors + coverage confidence remain future work.

**Phase 4 — scale-out (ongoing / future work)**
11. ⏳ API replay, per-host learned fetch ladder, scholarship association specificity ladder (L1–L5), URL-prediction reconciliation, WARC-replay CI determinism tests.

---

## 19. Determinism verification checklist

Run before declaring the system deterministic — and keep as a CI job:

- [ ] **Double-run test:** crawl the same university twice back-to-back; `dataset_hash` identical; exports byte-identical after removing the Summary timestamp row.
- [ ] **Replay test (hermetic):** record one crawl to WARC/HAR; replay through a local proxy on Windows AND Linux, 1 worker AND 8 workers → identical `dataset_hash`.
- [ ] **Order-independence test:** shuffle seed order artificially → identical output (proves set-based pipeline).
- [ ] **Kill-resume test:** kill the crawler at 50% and resume → identical output to an uninterrupted run.
- [ ] **Transient-noise test:** replay with injected 5% random 503s → course count unchanged (hysteresis carries forward), only `quarantined` counter differs.
- [ ] **Clock test:** run with `TZ=UTC` and `TZ=Australia/Sydney` → identical data files.
- [ ] **Sort-stability test:** export on Windows (node ICU) vs Linux → identical row order (codepoint sort).
- [ ] **Vocab-pin test:** edit a keyword → manifest_hash changes → exports refuse to compare against old runs without flagging version change.
- [ ] **Unchanged-site diff test:** two runs a day apart on an unchanged site → all courses `UNCHANGED`, zero NEW/REMOVED, audit confidence identical.
- [ ] **Golden university test:** a pinned WARC of one real university with known counts (e.g. CSU: 267 courses / 1 main eligibility / 65 scholarships) asserted in CI.

---

## 20. Deliverable → section map

| Requested deliverable | Section |
|---|---|
| 1. Redesigned architecture | § 2 |
| 2. Deterministic crawling algorithms | § 3 |
| 3. Validation engine | § 7 |
| 4. Revalidation engine | § 8 |
| 5. URL normalization | § 4 |
| 6. Eligibility URL detection | § 9 |
| 7. Scholarship URL detection | § 10 |
| 8. Data structures | § 14 |
| 9. Pseudocode | §§ 3.4, 4.1, 8.2, 9, 10 |
| 10. Flow diagrams | §§ 2, 8.2 |
| 11. Edge cases | § 17 |
| 12. Failure recovery | § 15 |
| 13. Performance | § 16 |
| 14. Reproducibility checklist | § 19 |
