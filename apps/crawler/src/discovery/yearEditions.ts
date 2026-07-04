/**
 * YEAR-EDITION COLLAPSE (part of redesign Step 7 — "stop low-value crawling").
 *
 * University catalogues/handbooks commonly publish the SAME course under one
 * URL per academic year:
 *
 *   handbook.uni.edu/course/2023/BSC-NURS
 *   handbook.uni.edu/course/2024/BSC-NURS
 *   handbook.uni.edu/course/2025/BSC-NURS   ← same course, five editions
 *   handbook.uni.edu/course/2026/BSC-NURS
 *   handbook.uni.edu/course/2027/BSC-NURS
 *
 * Crawling every edition multiplies the frontier by the number of archive years
 * (observed: ~1,900 of 2,756 pending URLs on one site) while adding zero new
 * targets — the current edition carries the live content. This module collapses
 * such families: for URLs that differ ONLY by a year path segment, only the
 * NEWEST edition seen is crawled.
 *
 * Deliberately conservative: URLs without a whole year path segment are never
 * touched, and the newest edition of every family is always kept — a catalogue
 * that only exists in year-versioned form keeps exactly one full copy, so
 * genuine target coverage is preserved.
 */

// A whole path segment that is a plausible academic year (1990–2039).
const YEAR_SEG = /\/(199\d|20[0-3]\d)(?=\/|$)/g;

export interface YearKey {
  /** URL with year segments normalized away — the "edition family" id. */
  key: string;
  /** The newest year found in the path. */
  year: number;
}

/** Extract the edition-family key for a URL, or null when it has no year segment. */
export function yearEditionKey(url: string): YearKey | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  YEAR_SEG.lastIndex = 0;
  if (!YEAR_SEG.test(u.pathname)) return null;
  let year = 0;
  const normalized = u.pathname.replace(YEAR_SEG, (m) => {
    const y = Number(m.slice(1));
    if (y > year) year = y;
    return "/~year~";
  });
  return { key: `${u.hostname.toLowerCase()}${normalized.toLowerCase()}`, year };
}

interface FamilyState {
  /** Newest year seen anywhere (observed, admitted or already crawled). */
  maxSeen: number;
  /** Year of the edition actually admitted for crawling (or crawled), if any. */
  admittedYear: number | null;
}

/**
 * Stateful gate: `shouldSkip(url)` returns true when the URL is an older (or
 * duplicate) edition of a family whose newest edition is being crawled instead.
 *
 * Order-independence for BULK sources (sitemap census, resume frontier): call
 * `observe(url)` over the whole batch first — that records each family's newest
 * year — then filter with `shouldSkip`, which admits exactly the newest edition
 * even when the batch arrives oldest-first. Streaming discovery may call
 * `shouldSkip` directly: first-seen wins, a newer edition still passes later.
 *
 * `seed(url)` marks a family as already CRAWLED at that year (resume), so older
 * siblings are skipped outright while a genuinely newer edition still passes.
 */
export function createYearEditionGate(): {
  /** Record that this edition exists in the frontier (no admission decision). */
  observe(url: string): void;
  /** Record a URL already crawled in a prior run. */
  seed(url: string): void;
  /** True → skip this URL (an equal-or-newer edition is admitted/crawled/known). */
  shouldSkip(url: string): boolean;
} {
  const fams = new Map<string, FamilyState>();
  const fam = (key: string): FamilyState => {
    let f = fams.get(key);
    if (!f) {
      f = { maxSeen: 0, admittedYear: null };
      fams.set(key, f);
    }
    return f;
  };
  return {
    observe(url: string) {
      const yk = yearEditionKey(url);
      if (!yk) return;
      const f = fam(yk.key);
      if (yk.year > f.maxSeen) f.maxSeen = yk.year;
    },
    seed(url: string) {
      const yk = yearEditionKey(url);
      if (!yk) return;
      const f = fam(yk.key);
      if (yk.year > f.maxSeen) f.maxSeen = yk.year;
      if (f.admittedYear === null || yk.year > f.admittedYear) f.admittedYear = yk.year;
    },
    shouldSkip(url: string) {
      const yk = yearEditionKey(url);
      if (!yk) return false;
      const f = fam(yk.key);
      if (yk.year < f.maxSeen) return true; // a newer edition exists in the frontier
      if (f.admittedYear !== null && f.admittedYear >= yk.year) return true; // equal/newer already admitted
      f.maxSeen = Math.max(f.maxSeen, yk.year);
      f.admittedYear = yk.year;
      return false;
    },
  };
}
