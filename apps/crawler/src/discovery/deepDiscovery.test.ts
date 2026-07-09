import { describe, it, expect } from "vitest";
import { shouldDeepDiscover, type DeepDiscoveryState } from "./deepDiscovery.js";

const base: DeepDiscoveryState = { enabled: true, passes: 0, maxPasses: 2, courseSurface: 800, validated: 50 };

describe("shouldDeepDiscover — bounded low-coverage gate", () => {
  it("fires when coverage is low and passes remain", () => {
    expect(shouldDeepDiscover(base)).toBe(true); // 50/800 = 6% < 15%
  });

  it("does NOT fire once coverage is healthy", () => {
    expect(shouldDeepDiscover({ ...base, validated: 200 })).toBe(false); // 200/800 = 25%
  });

  it("stops after the max passes (never loops forever)", () => {
    expect(shouldDeepDiscover({ ...base, passes: 2 })).toBe(false);
    expect(shouldDeepDiscover({ ...base, passes: 3 })).toBe(false);
  });

  it("is disabled when the feature flag is off", () => {
    expect(shouldDeepDiscover({ ...base, enabled: false })).toBe(false);
  });

  it("ignores tiny sites where the ratio is noise (but has some validation)", () => {
    expect(shouldDeepDiscover({ ...base, courseSurface: 20, validated: 2 })).toBe(false); // < minSurface
  });

  it("V4: triggers deep discovery when NO validation is found, even on zero or tiny course surface", () => {
    expect(shouldDeepDiscover({ ...base, courseSurface: 0, validated: 0 })).toBe(true);
    expect(shouldDeepDiscover({ ...base, courseSurface: 20, validated: 0 })).toBe(true);
  });

  it("respects custom thresholds", () => {
    expect(shouldDeepDiscover({ ...base, validated: 120, maxRatio: 0.2 })).toBe(true); // 15% < 20%
    expect(shouldDeepDiscover({ ...base, courseSurface: 40, minSurface: 50 })).toBe(false);
  });
});
