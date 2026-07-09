import { describe, it, expect } from "vitest";
import { createHostEscalationGovernor, HostBand } from "./hostEscalation.js";

describe("hostEscalation governor — adaptive per-host browser escalation", () => {
  it("escalates up to the probe budget, then blocks-by-protection", () => {
    const g = createHostEscalationGovernor(3);
    expect(g.decide("csu.edu.au")).toBe("escalate"); // probe 1
    expect(g.decide("csu.edu.au")).toBe("escalate"); // probe 2
    expect(g.decide("csu.edu.au")).toBe("escalate"); // probe 3 (budget spent)
    expect(g.decide("csu.edu.au")).toBe("blocked_by_protection");
    expect(g.decide("csu.edu.au")).toBe("blocked_by_protection");
  });

  it("tracks each registrable domain independently", () => {
    const g = createHostEscalationGovernor(2);
    expect(g.decide("a.edu")).toBe("escalate");
    expect(g.decide("a.edu")).toBe("escalate");
    expect(g.decide("a.edu")).toBe("blocked_by_protection");
    // a different host still has its full budget
    expect(g.decide("b.edu")).toBe("escalate");
    expect(g.decide("b.edu")).toBe("escalate");
    expect(g.decide("b.edu")).toBe("blocked_by_protection");
  });

  it("confirmed browser failures move a managed-challenge host to DISABLED (spec Phase 2)", () => {
    const g = createHostEscalationGovernor(10); // budget high, so the fail score decides
    // 4 probes the browser ALSO lost → failScore = 4*2 = 8 >= DISABLED_SCORE.
    for (let i = 0; i < 4; i++) {
      g.decide("cf.edu");
      g.noteBrowserOutcome("cf.edu", false); // browser still challenged
    }
    expect(g.band("cf.edu")).toBe(HostBand.DISABLED);
    expect(g.disabledHosts()).toContain("cf.edu");
    // once disabled, no further browser escalation even with budget remaining
    expect(g.decide("cf.edu")).toBe("blocked_by_protection");
  });

  it("a host the browser CAN bypass keeps escalating without spending budget", () => {
    const g = createHostEscalationGovernor(2); // small budget on purpose
    // First probe succeeds → host is proven solvable, so subsequent bot-blocks
    // keep escalating past the budget (the browser demonstrably works here).
    expect(g.decide("js.edu")).toBe("escalate");
    g.noteBrowserOutcome("js.edu", true);
    for (let i = 0; i < 5; i++) expect(g.decide("js.edu")).toBe("escalate");
    expect(g.band("js.edu")).not.toBe(HostBand.DISABLED);
  });

  it("successful browser extraction DECREASES the failure score (recovery)", () => {
    const g = createHostEscalationGovernor(10);
    g.noteBrowserOutcome("flaky.edu", false); // +2
    g.noteBrowserOutcome("flaky.edu", false); // +2 → 4 (SLOW)
    expect(g.band("flaky.edu")).toBe(HostBand.SLOW);
    g.noteBrowserOutcome("flaky.edu", true); // -1 → 3
    g.noteBrowserOutcome("flaky.edu", true); // -1 → 2
    g.noteBrowserOutcome("flaky.edu", true); // -1 → 1
    expect(g.band("flaky.edu")).toBe(HostBand.NORMAL);
    expect(g.score("flaky.edu")).toBe(1);
  });

  it("scores/bands an unseen host as normal", () => {
    const g = createHostEscalationGovernor(5);
    expect(g.score("unseen.edu")).toBe(0);
    expect(g.band("unseen.edu")).toBe(HostBand.NORMAL);
  });

  it("a budget below 1 is clamped to at least one probe", () => {
    const g = createHostEscalationGovernor(0);
    expect(g.decide("x.edu")).toBe("escalate");
    expect(g.decide("x.edu")).toBe("blocked_by_protection");
  });
});
