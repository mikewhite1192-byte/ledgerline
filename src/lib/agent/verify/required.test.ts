import { describe, expect, it } from "vitest";
import {
  coverageOf,
  fanoutCoverage,
  gatewayVerification,
  persistVerification,
  PROPOSAL_CHECK_WORDS,
  PROPOSAL_REQUIRED_CHECKS,
  parseSweepCoverage,
  requiredSweepSteps,
  sweepCoverage,
  SWEEP_ENGINE_CHECKS,
  SWEEP_REQUIRED_CHECKS,
} from "./required";

const ALL = new Set<string>(SWEEP_REQUIRED_CHECKS);

describe("what every pay sweep must do", () => {
  it("lists the run's steps, the second look only with room for it", () => {
    expect(requiredSweepSteps(false)).toEqual(["find", "draft", "audit"]);
    expect(requiredSweepSteps(true)).toEqual(["find", "plan", "check", "draft", "audit"]);
  });

  it("requires the engine's pay checks, the payment on the wrong invoice check and the settlement exceptions", () => {
    expect(SWEEP_REQUIRED_CHECKS).toHaveLength(9);
    expect(new Set(SWEEP_REQUIRED_CHECKS).size).toBe(9);
    expect(SWEEP_REQUIRED_CHECKS.slice(0, SWEEP_ENGINE_CHECKS.length)).toEqual([...SWEEP_ENGINE_CHECKS]);
  });
});

describe("the sweep's coverage figure", () => {
  it("is 100 when every required check ran over every driver", () => {
    expect(sweepCoverage(ALL, { total: 12, checked: 12 })).toEqual({
      v: 1,
      checks: { required: 9, ran: 9 },
      drivers: { total: 12, checked: 12 },
      pct: 100,
    });
  });

  it("counts only the required checks, and rounds a short run down", () => {
    const short = new Set([...SWEEP_REQUIRED_CHECKS.slice(1), "fuel_off_route", "made_up"]);
    expect(sweepCoverage(short, { total: 12, checked: 12 })).toMatchObject({ checks: { required: 9, ran: 8 }, pct: 88 });
    expect(sweepCoverage(ALL, { total: 12, checked: 11 })).toMatchObject({ drivers: { total: 12, checked: 11 }, pct: 91 });
    expect(sweepCoverage(new Set(), { total: 12, checked: 12 })).toMatchObject({ checks: { ran: 0 }, pct: 0 });
  });

  it("never counts more drivers checked than there are, and with no drivers is the checks' share", () => {
    expect(sweepCoverage(ALL, { total: 3, checked: 7 })).toMatchObject({ drivers: { total: 3, checked: 3 }, pct: 100 });
    expect(sweepCoverage(ALL, { total: 0, checked: 0 })).toMatchObject({ drivers: { total: 0, checked: 0 }, pct: 100 });
  });

  it("takes the second opinion's planned and checked drivers from the comparison's counts", () => {
    expect(fanoutCoverage({ drivers_checked: 10, drivers_unchecked: 2 })).toEqual({ planned: 12, checked: 10 });
    expect(fanoutCoverage({ drivers_checked: 0, drivers_unchecked: 0 })).toEqual({ planned: 0, checked: 0 });
  });

  it("reads the stored column back, and anything else as none", () => {
    const stored = { ...sweepCoverage(ALL, { total: 12, checked: 12 }), fanout: { planned: 12, checked: 12 } };
    expect(parseSweepCoverage(JSON.stringify(stored))).toEqual(stored);
    expect(parseSweepCoverage(null)).toBeNull();
    expect(parseSweepCoverage("not json")).toBeNull();
    expect(parseSweepCoverage("[]")).toBeNull();
    expect(parseSweepCoverage(JSON.stringify({ ...stored, v: 2 }))).toBeNull();
    expect(parseSweepCoverage(JSON.stringify({ ...stored, pct: 101 }))).toBeNull();
    expect(parseSweepCoverage(JSON.stringify({ ...stored, extra: true }))).toBeNull();
  });
});

describe("what every proposal must pass", () => {
  it("lists five checks in the order they run, each with plain words", () => {
    expect(PROPOSAL_REQUIRED_CHECKS).toEqual(["schema", "records_exist", "engine_limit", "sources_in_record", "engine_recompute"]);
    expect(Object.keys(PROPOSAL_CHECK_WORDS)).toEqual([...PROPOSAL_REQUIRED_CHECKS]);
    for (const words of Object.values(PROPOSAL_CHECK_WORDS)) expect(words).toMatch(/^[A-Z][a-z ]+$/);
  });

  it("names the step a gateway refusal stopped at, and claims no check after it", () => {
    expect(gatewayVerification("unknown_record")).toEqual({ failed: ["records_exist"], passed: ["schema"] });
    for (const reason of ["amount_over_limit", "engine_refused", "limit_unavailable", "budget"]) {
      expect(gatewayVerification(reason)).toEqual({ failed: ["engine_limit"], passed: ["schema", "records_exist"] });
    }
    expect(gatewayVerification("screen_flagged")).toEqual({ failed: [], passed: ["schema", "records_exist", "engine_limit"] });
    expect(gatewayVerification("something_new")).toEqual({ failed: [], passed: ["schema"] });
  });

  it("names the loop's refusals before the insert, and an accepted card with or without a recompute", () => {
    expect(persistVerification("citation_not_in_record", false)).toEqual({
      failed: ["sources_in_record"],
      passed: ["schema", "records_exist", "engine_limit"],
    });
    for (const refusal of ["engine_mismatch", "limit_unavailable"] as const) {
      expect(persistVerification(refusal, false).failed).toEqual(["engine_recompute"]);
    }
    expect(persistVerification(null, true).passed).toEqual([...PROPOSAL_REQUIRED_CHECKS]);
    expect(persistVerification(null, false).passed).not.toContain("engine_recompute");
  });

  it("counts the checks a card passed, each once, rounded down", () => {
    expect(coverageOf(PROPOSAL_REQUIRED_CHECKS)).toEqual({ required: 5, passed: 5, pct: 100 });
    expect(coverageOf(["schema", "schema", "records_exist", "not_a_check"])).toEqual({ required: 5, passed: 2, pct: 40 });
    expect(coverageOf(persistVerification(null, false).passed)).toEqual({ required: 5, passed: 4, pct: 80 });
  });
});
