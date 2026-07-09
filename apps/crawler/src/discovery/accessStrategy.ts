/**
 * ACCESS STRATEGY ENGINE — the single, explicit decision layer for "what do we
 * do with this fetch result?". It encodes the hybrid rule the whole engine
 * already follows, in one pure, testable place:
 *
 *   HTTP 200 + real content        → SERVE  (hand to the V2 validation engine)
 *   JS shell / thin content        → ESCALATE "thin"     (needs a real render)
 *   dynamic finder (decided later) → ESCALATE "finder"   (post-classification)
 *   transport failure              → ESCALATE "network"  (browser retry)
 *   Cloudflare challenge / 403/429/503:
 *        ESCALATE_BOT_BLOCKS off              → BLOCK (defer; fast-lane recovers)
 *        on, host still within probe budget   → ESCALATE (browser PROBE)
 *        on, host budget spent / DISABLED     → BLOCK protection=true
 *                                               (BLOCKED_BY_PROTECTION — candidate)
 *
 * A BLOCKED bot-block page is NOT discarded: it was still discovered (sitemap /
 * anchors classified it), so it surfaces as a CANDIDATE via discovery-export and
 * is retried by the coverage-recovery pass / a Resume once the host is reachable
 * (e.g. from a different IP). Only bot-blocks are ever governed by the probe
 * budget; JS/finder/network browser needs are never capped — validation accuracy
 * on real dynamic pages comes first.
 *
 * This function is PURE (no I/O, no side effects). The caller performs the side
 * effects (escalate / markBlockedFast / throttle back-off) and — crucially — only
 * calls the stateful host governor when `decide` is actually needed, passing its
 * result in, so a decision never double-counts a probe.
 */
export type AssessReason = "bot-challenge" | "blocked-status" | "network" | "thin-content" | null | undefined;

export type AccessDecision =
  | { action: "serve" }
  | { action: "escalate"; reason: "network" | "thin" | "challenge" | "blocked" }
  | { action: "block"; reason: "challenge" | "blocked"; protection: boolean };

export interface AccessInput {
  /** assessFastFetch verdict: was the page a clean, servable HTTP response? */
  serveFast: boolean;
  /** assessFastFetch reason (only consulted when !serveFast). */
  reason: AssessReason;
  /** env.ESCALATE_BOT_BLOCKS — may bot-blocked pages go to the browser at all? */
  escalateBotBlocks: boolean;
  /** env.HOST_BROWSER_PROBE_BUDGET > 0 — is the adaptive per-host probe cap on? */
  probeCapEnabled: boolean;
  /** hostGovernor.decide(domain) — ONLY meaningful for a bot-block being escalated;
   *  pass "escalate" otherwise (it is ignored on non-bot-block paths). */
  governorDecision: "escalate" | "blocked_by_protection";
}

/** True for the reasons the probe budget governs (Cloudflare / 403 / 429 / 503). */
export function isBotBlock(reason: AssessReason): boolean {
  return reason === "bot-challenge" || reason === "blocked-status";
}

export function decideAccess(i: AccessInput): AccessDecision {
  if (i.serveFast) return { action: "serve" };
  if (i.reason === "network") return { action: "escalate", reason: "network" };
  if (isBotBlock(i.reason)) {
    const reason = i.reason === "bot-challenge" ? "challenge" : "blocked";
    // Never send bot-blocks to the browser → defer as BLOCKED (recoverable).
    if (!i.escalateBotBlocks) return { action: "block", reason, protection: false };
    // Probe budget available (or cap off) → one browser PROBE for this host.
    if (!i.probeCapEnabled || i.governorDecision === "escalate") return { action: "escalate", reason };
    // Budget spent / host DISABLED → stop grinding the browser: BLOCKED_BY_PROTECTION.
    return { action: "block", reason, protection: true };
  }
  // Any other non-serve reason (thin-content JS shell, unknown) → needs a real render.
  return { action: "escalate", reason: "thin" };
}
