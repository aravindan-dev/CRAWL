import { describe, it, expect } from "vitest";
import { decideAccess, isBotBlock, type AccessInput } from "./accessStrategy.js";

const base: AccessInput = { serveFast: false, reason: undefined, escalateBotBlocks: false, probeCapEnabled: true, governorDecision: "escalate" };

describe("decideAccess — the ACCESS_STRATEGY_ENGINE decision table", () => {
  it("HTTP 200 + real content → SERVE (V2 validation)", () => {
    expect(decideAccess({ ...base, serveFast: true })).toEqual({ action: "serve" });
  });

  it("thin JS shell → ESCALATE to browser (never capped)", () => {
    expect(decideAccess({ ...base, reason: "thin-content" })).toEqual({ action: "escalate", reason: "thin" });
  });

  it("transport failure → ESCALATE network (never capped)", () => {
    expect(decideAccess({ ...base, reason: "network" })).toEqual({ action: "escalate", reason: "network" });
  });

  it("Cloudflare challenge with ESCALATE_BOT_BLOCKS OFF → BLOCK, not protection (deferred, recoverable)", () => {
    expect(decideAccess({ ...base, reason: "bot-challenge", escalateBotBlocks: false }))
      .toEqual({ action: "block", reason: "challenge", protection: false });
  });

  it("403/429/503 with ESCALATE_BOT_BLOCKS OFF → BLOCK, not protection", () => {
    expect(decideAccess({ ...base, reason: "blocked-status", escalateBotBlocks: false }))
      .toEqual({ action: "block", reason: "blocked", protection: false });
  });

  it("bot-block, budget available → ESCALATE a browser probe", () => {
    expect(decideAccess({ ...base, reason: "bot-challenge", escalateBotBlocks: true, governorDecision: "escalate" }))
      .toEqual({ action: "escalate", reason: "challenge" });
  });

  it("bot-block, host budget spent/DISABLED → BLOCK protection (BLOCKED_BY_PROTECTION)", () => {
    expect(decideAccess({ ...base, reason: "blocked-status", escalateBotBlocks: true, governorDecision: "blocked_by_protection" }))
      .toEqual({ action: "block", reason: "blocked", protection: true });
  });

  it("bot-block, ESCALATE on but probe cap OFF (budget 0) → always ESCALATE (legacy)", () => {
    expect(decideAccess({ ...base, reason: "bot-challenge", escalateBotBlocks: true, probeCapEnabled: false, governorDecision: "blocked_by_protection" }))
      .toEqual({ action: "escalate", reason: "challenge" });
  });

  it("isBotBlock recognises only the probe-governed reasons", () => {
    expect(isBotBlock("bot-challenge")).toBe(true);
    expect(isBotBlock("blocked-status")).toBe(true);
    expect(isBotBlock("thin")).toBe(false);
    expect(isBotBlock("network")).toBe(false);
    expect(isBotBlock(null)).toBe(false);
  });
});
