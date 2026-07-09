/**
 * PER-HOST BROWSER-ESCALATION GOVERNOR — adaptive bot-block handling.
 *
 * Bot-blocked pages (Cloudflare managed challenge / 403 / 429 / 503) are the ONE
 * escalation case whose browser cost is only CONDITIONALLY worth paying: a real
 * headless browser auto-solves a plain JS "checking your browser" challenge, but
 * it CANNOT solve a *managed* challenge — there it just grinds ~5 pages/min for
 * zero yield while hammering the flagged host (the observed ~8 pages/min
 * bottleneck when ESCALATE_BOT_BLOCKS sends EVERY blocked page to the browser).
 *
 * The governor decides, per REGISTRABLE DOMAIN, whether a bot-blocked page may be
 * escalated to the browser:
 *   - unknown host: escalate up to `probeBudget` PROBES ("can the browser get in?")
 *   - proven SOLVABLE (a browser probe bypassed the challenge, no recent failures):
 *     keep escalating — the browser demonstrably works on this host
 *   - proven UNSOLVABLE (failure score reached the DISABLED band): stop — every
 *     further bot-blocked page is recorded BLOCKED_BY_PROTECTION immediately (fast)
 *
 * The browser lane feeds `noteBrowserOutcome` back: a bypass DECREASES the host's
 * failure score (recovery), a still-challenged render INCREASES it. So a managed-
 * challenge host climbs to the DISABLED band on its own and later contexts/crawls
 * skip the browser for it entirely, while a genuinely solvable host is never
 * permanently capped. One difficult university can therefore never drag the whole
 * crawl to browser speed.
 *
 * ONLY bot-block reasons are governed here. Legitimate browser needs (JS shell /
 * thin content / dynamic finder / network retry) are never capped — accuracy and
 * coverage of real dynamic pages come first. State is process-lifetime and shared
 * across universities/contexts so the intelligence accumulates; a process restart
 * resets it, and it only ever gates BROWSER escalation, never plain HTTP fetching,
 * so a recovered host is always re-fetched fast regardless.
 *
 * host_block_score bands (spec Phase 2): 0-3 normal · 4-7 slow · >=8 disabled.
 */
export const HostBand = { NORMAL: "normal", SLOW: "slow", DISABLED: "disabled" } as const;
export type HostBand = (typeof HostBand)[keyof typeof HostBand];

export type EscalationDecision = "escalate" | "blocked_by_protection";

/** Failure score at/above which the browser fallback is disabled for a host. */
export const DISABLED_SCORE = 8;
/** A confirmed "browser also blocked" outcome adds this to the failure score… */
const FAIL_WEIGHT = 2;
/** …and a confirmed bypass subtracts this (recovery), floored at zero. */
const RECOVER_WEIGHT = 1;

export interface HostEscalationGovernor {
  /** Decide a bot-blocked page: escalate a probe to the browser, or block now. */
  decide(domain: string): EscalationDecision;
  /** Browser-lane feedback: bypassed=true lowers the failure score (recovery);
   *  bypassed=false (still challenged after render) raises it toward DISABLED. */
  noteBrowserOutcome(domain: string, bypassed: boolean): void;
  /** host_block_score (failure score) for a domain (0 when unseen). */
  score(domain: string): number;
  /** Coarse band derived from the score. */
  band(domain: string): HostBand;
  /** Domains currently in the DISABLED band (browser fallback switched off). */
  disabledHosts(): string[];
}

export function createHostEscalationGovernor(probeBudget: number): HostEscalationGovernor {
  const budget = Math.max(1, Math.floor(probeBudget));
  const attempts = new Map<string, number>();  // browser probes spent on the host
  const successes = new Map<string, number>();  // probes the browser bypassed
  const failScore = new Map<string, number>();  // protection failure score (0-based)
  const get = (m: Map<string, number>, k: string) => m.get(k) ?? 0;

  const score = (d: string) => get(failScore, d);
  const band = (d: string): HostBand => {
    const s = score(d);
    if (s >= DISABLED_SCORE) return HostBand.DISABLED;
    if (s >= 4) return HostBand.SLOW;
    return HostBand.NORMAL;
  };

  return {
    decide(domain) {
      if (band(domain) === HostBand.DISABLED) return "blocked_by_protection";
      // Proven solvable (a probe bypassed, nothing has failed since) → the browser
      // demonstrably works on this host; keep escalating without spending budget.
      if (get(successes, domain) > 0 && get(failScore, domain) === 0) return "escalate";
      if (get(attempts, domain) < budget) {
        attempts.set(domain, get(attempts, domain) + 1);
        return "escalate";
      }
      return "blocked_by_protection"; // budget spent with no positive proof yet
    },
    noteBrowserOutcome(domain, bypassed) {
      if (bypassed) {
        successes.set(domain, get(successes, domain) + 1);
        failScore.set(domain, Math.max(0, get(failScore, domain) - RECOVER_WEIGHT));
      } else {
        failScore.set(domain, get(failScore, domain) + FAIL_WEIGHT);
      }
    },
    score,
    band,
    disabledHosts() {
      const out: string[] = [];
      for (const d of failScore.keys()) if (band(d) === HostBand.DISABLED) out.push(d);
      return out;
    },
  };
}
