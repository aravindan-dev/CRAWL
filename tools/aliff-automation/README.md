# Aliff Super Admin Automation

Safe Playwright automation that reads your **verified** Excel/CSV and adds/updates
**university-level** and **course-level** records in Aliff Super Admin
(`https://super-admin-v2.aliff.in`).

Standalone module — **not** part of the CLG Search crawler/API/web. It only reads
the Excel and fills the portal. It does **not** re-verify URLs or search the web.

> **Most important rule:** university eligibility links go ONLY into Manage
> Universities; course eligibility links go ONLY into Manage Courses. The code
> keeps them strictly separate (`university_eligibility_url` vs `course_eligibility_url`).

## ⚠️ Selectors need a one-time tune

The portal's exact HTML is unknown, so the selectors in [`src/config.ts`](src/config.ts)
(`selectors`) are **best-guess** accessible locators (by label/role/placeholder).
**Run a DRY_RUN first, look at `screenshots/`, and adjust `selectors` to match.**
This is exactly what the staged run order below is for.

## Setup

```bash
cd "C:\Users\ashok\OneDrive\Desktop\JOB - CLAUDE\tools\aliff-automation"
npm install
npm run install:browser          # one-time: installs Chromium for Playwright
copy .env.example .env           # then edit .env
```

`.env` (never commit it):
```
ALIFF_EMAIL=your_email
ALIFF_PASSWORD=your_password
DRY_RUN=true
OVERWRITE=false
INPUT_FILE=data/verified-input.xlsx
LIMIT=5
PROCESS=both        # universities | courses | both
HEADLESS=false      # watch it during dry runs
```

## Input format

Put your verified file at `data/verified-input.xlsx` (or `.csv`). One row per
course; university-level fields may live on a university-only row or repeat on
course rows. Headers are matched flexibly. See [`data/sample-input.csv`](data/sample-input.csv).

University fields: `university_name, country, base_url, university_eligibility_url,
university_scholarship_url, university_fee_url, brochure_link, university_logo, notes`

Course fields: `university_name, country, course_name, degree_level, campus,
course_category, course_url, course_eligibility_url, course_scholarship_url,
course_fee_url, additional_information_link, notes`

> The crawler's `eligibility-urls-CLEAN.xlsx` provides the *URLs* but not course
> names/levels — fill those in (or join from your course list) to build this input.

## Staged run order (do not skip)

```bash
# 1) DRY RUN, 5 rows — fills + screenshots + logs, NO saving
#    (LIMIT=5, DRY_RUN=true already in .env)
npm run dry

# 2) Check screenshots/ and reports/automation-log.xlsx. Fix selectors if needed.

# 3) COMMIT, 5 rows
#    set DRY_RUN=false (or:)  set LIMIT=5 then:
npm run commit

# 4) 50 rows:  set LIMIT=50 ; npm run commit
# 5) Full:     set LIMIT=0  ; npm run commit
```

## Safety & behavior

- **DRY_RUN=true (default):** never clicks final Save — fills, screenshots, logs the planned action.
- **OVERWRITE=false (default):** existing non-empty fields are left untouched; only empty fields filled.
- **Duplicate prevention:** always searches first; courses match on `course_name` + `university_name`. Unsure → manual review.
- **Dropdowns** (University, Level): exact match → normalized match → else **manual review** (never saves a wrong value).
- **Retries:** each record retried `RETRIES` times; still failing → logged as failed, continues.
- **Checkpoints:** every 25 records → reports flushed + `automation-progress.json` saved. Commit runs **resume** from where they stopped.

## Outputs

- `reports/automation-log.xlsx` — every action (row, type, names, action, status, reason, old/new value, screenshot, timestamp)
- `reports/failed-records.xlsx`
- `reports/manual-review.xlsx`
- `screenshots/` — before/after each record
- `automation-progress.json` — resume state

## Final summary (printed)

universities processed/created/updated · courses processed/created/updated ·
skipped duplicates · failed rows · manual review rows.
