/**
 * BRANCH-YIELD PRUNING (redesign Step 7 — "stop low-value crawling").
 *
 * The crawler tracks how many VALIDATED targets each URL branch (first path
 * segment, e.g. /news, /about, /research) has produced. A branch that has been
 * visited many times and produced ZERO targets is a dead end: we stop spending
 * the crawl budget expanding its LOW-tier ("discover-only") child links.
 *
 * Deliberately conservative to protect coverage (a hard spec requirement):
 *   - Only LOW-tier links (below MIN_LINK_SCORE, i.e. generic section pages that
 *     merely *lead toward* targets) are ever suppressed. Course / eligibility /
 *     scholarship candidate links (EXTRACT tier) and sitemap-seeded catalogue
 *     pages are ALWAYS followed — genuine target coverage is never dropped.
 *   - A branch must cross a high visit threshold with zero targets before it is
 *     considered dead, so a slow-to-yield section is not pruned prematurely.
 *   - A single validated target anywhere in a branch permanently revives it.
 *
 * Pure and unit-testable: no I/O, no crawler state beyond its own counters.
 */
export interface BranchYieldConfig {
  /** Visits with zero targets before a branch is treated as dead. */
  minPages: number;
}

export interface BranchYield {
  /** Record that a page in `url`'s branch was visited (and whether it validated). */
  record(url: string, validated: boolean): void;
  /** Should LOW-tier discovery from this branch be suppressed right now? */
  isDead(url: string): boolean;
  /** Diagnostics: branches currently considered dead. */
  deadBranches(): string[];
}

/** First path segment of a URL — the "branch". Root/opaque URLs share "/" . */
export function branchKey(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0];
    return seg ? seg.toLowerCase() : "/";
  } catch {
    return "/";
  }
}

export function createBranchYield(cfg: BranchYieldConfig): BranchYield {
  const minPages = Math.max(1, cfg.minPages);
  const pages = new Map<string, number>();
  const targets = new Map<string, number>();

  return {
    record(url: string, validated: boolean) {
      const k = branchKey(url);
      pages.set(k, (pages.get(k) ?? 0) + 1);
      if (validated) targets.set(k, (targets.get(k) ?? 0) + 1);
    },
    isDead(url: string) {
      const k = branchKey(url);
      // The root branch is never pruned — it's the hub every crawl fans out from.
      if (k === "/") return false;
      if ((targets.get(k) ?? 0) > 0) return false; // proven productive → keep
      return (pages.get(k) ?? 0) >= minPages;
    },
    deadBranches() {
      const out: string[] = [];
      for (const [k, p] of pages) {
        if (k !== "/" && (targets.get(k) ?? 0) === 0 && p >= minPages) out.push(k);
      }
      return out;
    },
  };
}
