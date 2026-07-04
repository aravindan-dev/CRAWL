import { describe, it, expect } from "vitest";
import { createThrottle, signalFor } from "./throttle.js";

const cfg = { baseDelayMs: 300, maxDelayMs: 8000, maxConcurrency: 3, minConcurrency: 1 };

describe("createThrottle", () => {
  it("starts with zero delay and full concurrency (no fixed sleep when healthy)", () => {
    const t = createThrottle(cfg);
    expect(t.delayMs).toBe(0);
    expect(t.concurrency).toBe(3);
  });

  it("keeps delay at 0 across a run of healthy responses", () => {
    const t = createThrottle(cfg);
    for (let i = 0; i < 20; i++) t.note("ok");
    expect(t.delayMs).toBe(0);
    expect(t.concurrency).toBe(3);
  });

  it("hard-backoffs and drops to min concurrency immediately on 429", () => {
    const t = createThrottle(cfg);
    t.note("rateLimited");
    expect(t.delayMs).toBeGreaterThanOrEqual(300);
    expect(t.concurrency).toBe(1);
  });

  it("escalates delay on repeated rate limiting up to the cap", () => {
    const t = createThrottle(cfg);
    for (let i = 0; i < 20; i++) t.note("rateLimited");
    expect(t.delayMs).toBe(8000);
    expect(t.concurrency).toBe(1);
  });

  it("does not back off on a single 5xx / timeout (one dead page is cheap)", () => {
    const t = createThrottle(cfg);
    t.note("serverError");
    t.note("timeout");
    expect(t.delayMs).toBe(0);
  });

  it("backs off after 3 consecutive server errors and reduces concurrency", () => {
    const t = createThrottle(cfg);
    t.note("serverError");
    t.note("serverError");
    t.note("serverError");
    expect(t.delayMs).toBeGreaterThan(0);
    expect(t.concurrency).toBe(2);
  });

  it("decays delay back toward 0 after sustained health", () => {
    const t = createThrottle(cfg);
    t.note("rateLimited"); // delay = 300, conc = 1
    const backedOff = t.delayMs;
    for (let i = 0; i < 5; i++) t.note("ok");
    expect(t.delayMs).toBeLessThan(backedOff);
  });

  it("recovers concurrency after prolonged health once delay is gone", () => {
    const t = createThrottle({ ...cfg, decayAfter: 1, recoverAfter: 2 });
    t.note("rateLimited"); // conc -> 1, delay = 300
    for (let i = 0; i < 40; i++) t.note("ok");
    expect(t.concurrency).toBe(3);
    expect(t.delayMs).toBe(0);
  });

  it("never returns concurrency below the floor or above the ceiling", () => {
    const t = createThrottle(cfg);
    for (let i = 0; i < 50; i++) t.note("rateLimited");
    expect(t.concurrency).toBe(1);
    for (let i = 0; i < 200; i++) t.note("ok");
    expect(t.concurrency).toBeLessThanOrEqual(3);
  });
});

describe("politeness floor (minDelayMs)", () => {
  it("starts at the floor and never decays below it", () => {
    const t = createThrottle({ ...cfg, minDelayMs: 100 });
    expect(t.delayMs).toBe(100);
    for (let i = 0; i < 100; i++) t.note("ok");
    expect(t.delayMs).toBe(100);
  });

  it("backs off above the floor and decays back down to it (not to 0)", () => {
    const t = createThrottle({ ...cfg, minDelayMs: 100, decayAfter: 1 });
    t.note("rateLimited");
    expect(t.delayMs).toBeGreaterThan(100);
    for (let i = 0; i < 50; i++) t.note("ok");
    expect(t.delayMs).toBe(100);
  });

  it("defaults to no floor when minDelayMs is omitted", () => {
    const t = createThrottle(cfg);
    expect(t.delayMs).toBe(0);
  });
});

describe("signalFor", () => {
  it("maps timeouts, 429/503, 5xx and healthy statuses", () => {
    expect(signalFor(null, true)).toBe("timeout");
    expect(signalFor(429)).toBe("rateLimited");
    expect(signalFor(503)).toBe("rateLimited");
    expect(signalFor(500)).toBe("serverError");
    expect(signalFor(502)).toBe("serverError");
    expect(signalFor(200)).toBe("ok");
    expect(signalFor(301)).toBe("ok");
    expect(signalFor(404)).toBe("ok"); // 404 is a dead page, not a throttle signal
    expect(signalFor(null)).toBe("ok");
  });
});
