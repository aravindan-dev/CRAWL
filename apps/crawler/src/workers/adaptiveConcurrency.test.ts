import { describe, it, expect } from "vitest";
import { nextConcurrency, type AdaptiveConfig, type ResourceSample } from "./adaptiveConcurrency.js";

const cfg: AdaptiveConfig = { min: 5, max: 20, step: 5, lowMemRatio: 0.12, highMemRatio: 0.3, highLoadPerCpu: 0.9 };
const sample = (o: Partial<ResourceSample>): ResourceSample => ({ freeMemRatio: 0.5, loadPerCpu: 0.2, pendingWork: 100, ...o });

describe("nextConcurrency — adaptive scaling decision", () => {
  it("scales UP when saturated with RAM+CPU headroom", () => {
    expect(nextConcurrency(5, sample({ freeMemRatio: 0.5, loadPerCpu: 0.3, pendingWork: 50 }), cfg)).toBe(10);
    expect(nextConcurrency(10, sample({ pendingWork: 50 }), cfg)).toBe(15);
  });

  it("never exceeds the max ceiling", () => {
    expect(nextConcurrency(20, sample({ pendingWork: 500 }), cfg)).toBe(20);
    expect(nextConcurrency(18, sample({ pendingWork: 500 }), cfg)).toBe(20); // clamped, not 23
  });

  it("does NOT scale up when there is no queued work beyond current slots", () => {
    expect(nextConcurrency(5, sample({ pendingWork: 3 }), cfg)).toBe(5);
    expect(nextConcurrency(5, sample({ pendingWork: 5 }), cfg)).toBe(5); // not strictly greater
  });

  it("steps DOWN under memory pressure (memory protection / backpressure)", () => {
    expect(nextConcurrency(15, sample({ freeMemRatio: 0.08, pendingWork: 500 }), cfg)).toBe(10);
  });

  it("never drops below the min floor", () => {
    expect(nextConcurrency(5, sample({ freeMemRatio: 0.05 }), cfg)).toBe(5);
  });

  it("does NOT scale up when RAM headroom is thin (between low and high)", () => {
    expect(nextConcurrency(5, sample({ freeMemRatio: 0.2, pendingWork: 500 }), cfg)).toBe(5);
  });

  it("steps DOWN under sustained high CPU load", () => {
    expect(nextConcurrency(15, sample({ loadPerCpu: 1.5, pendingWork: 500 }), cfg)).toBe(10);
  });

  it("does not scale up when CPU is near the limit even with RAM free", () => {
    // loadPerCpu 0.8 is below highLoadPerCpu(0.9) so no step-down, but above the
    // 0.8*0.9=0.72 headroom gate, so it must not step up either.
    expect(nextConcurrency(5, sample({ loadPerCpu: 0.8, freeMemRatio: 0.5, pendingWork: 500 }), cfg)).toBe(5);
  });

  it("treats unknown CPU load (Windows, null) as not-a-blocker for scaling", () => {
    expect(nextConcurrency(5, sample({ loadPerCpu: null, freeMemRatio: 0.5, pendingWork: 500 }), cfg)).toBe(10);
  });
});
