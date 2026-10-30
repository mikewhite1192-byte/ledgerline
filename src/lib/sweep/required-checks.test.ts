import { describe, expect, it } from "vitest";
import { SWEEP_ENGINE_CHECKS, SWEEP_REQUIRED_CHECKS } from "../agent/verify/required";
import { checkInputOf } from "../data/records";
import { RUN_ALL_CHECKS, runAllChecks } from "../rules-engine";
import { CHECK_NAMES } from "../rules-engine/types";
import { DEMO_CARRIERS } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";

// The sweep's required checks (agent/verify/required.ts) are written out by name, since agent
// code never imports the engine. These hold the names to the engine's own.
describe("the sweep's required checks against the engine", () => {
  it("names only checks the engine has, the settlement exceptions aside", () => {
    for (const c of SWEEP_REQUIRED_CHECKS) {
      if (c !== "settlement") expect(CHECK_NAMES as readonly string[], c).toContain(c);
    }
  });

  it("names exactly the checks the engine's pay pass is built from, in its order", () => {
    expect([...SWEEP_ENGINE_CHECKS]).toEqual([...RUN_ALL_CHECKS]);
  });

  it("reports nothing on the demo week from a check outside the pay pass's list", () => {
    for (const carrier of DEMO_CARRIERS) {
      const plan = buildCarrierPlan(carrier, "2026-11-02");
      const seen = new Set(runAllChecks(checkInputOf(plan.rows)).map((f) => f.check));
      expect(seen.size).toBeGreaterThan(0);
      for (const c of seen) expect(RUN_ALL_CHECKS as readonly string[], c).toContain(c);
    }
  });
});
