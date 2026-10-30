import { describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { clampToMaxTurns } from "./run-limits";

// The ceiling over every run only ever tightens a cap: never above the cap it is given, never
// above maxTurns, and a bad maxTurns or cap stops the run (zero) rather than lifting it.

describe("clampToMaxTurns", () => {
  it("never raises a cap, over every pair of caps and ceilings", () => {
    const caps = [0, 1, 4, 15, 29, 30, 31, 40, 100, 1_000, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY];
    const ceilings = [0, 1, 3, 15, 30, 31, 1_000];
    for (const cap of caps) {
      for (const maxTurns of ceilings) {
        const out = clampToMaxTurns(cap, maxTurns);
        expect(out, `cap ${cap}, maxTurns ${maxTurns}`).toBeLessThanOrEqual(cap);
        expect(out, `cap ${cap}, maxTurns ${maxTurns}`).toBeLessThanOrEqual(maxTurns);
        expect(out).toBe(Math.min(cap, maxTurns));
      }
    }
  });

  it("reads the shipped ceiling by default: the fan-out's 30 drivers and the portal's 15 steps stay", () => {
    expect(flags.runLimits.maxTurns).toBe(30);
    expect(clampToMaxTurns(flags.fanoutLimits.maxDrivers)).toBe(flags.fanoutLimits.maxDrivers);
    expect(clampToMaxTurns(flags.portalRunLimits.maxSteps)).toBe(flags.portalRunLimits.maxSteps);
    expect(clampToMaxTurns(Number.MAX_SAFE_INTEGER)).toBe(30);
  });

  it("stops a run when the ceiling or the cap is not a usable number", () => {
    for (const bad of [Number.NaN, -1, 2.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(clampToMaxTurns(15, bad), `maxTurns ${bad}`).toBe(0);
    }
    expect(clampToMaxTurns(Number.NaN, 30)).toBe(0);
  });
});
