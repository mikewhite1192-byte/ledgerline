import { describe, expect, it } from "vitest";
import { PROPOSAL_KINDS } from "../agent/gateway/types";
import { DEMO_ANCHOR } from "../seed/anchor";
import { DEMO_CARRIERS } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { buildCases, selectCases, TEN_CASE_KEYS } from "./cases";

const cases = buildCases(DEMO_ANCHOR);
const plans = new Map<string, ReturnType<typeof buildCarrierPlan>>(DEMO_CARRIERS.map((c) => [c.slug, buildCarrierPlan(c, DEMO_ANCHOR)]));

describe("eval cases", () => {
  it("30 cases, 24 without fuel, ids resolve in the plan", () => {
    expect(cases).toHaveLength(30);
    expect(new Set(cases.map((c) => c.key)).size).toBe(30);
    expect(cases.filter((c) => c.kind !== "fuel")).toHaveLength(24);
    // The fuel checks start on a fixed date; a planted fill-up before it has nothing to find.
    expect(cases.filter((c) => c.skip !== null).map((c) => c.key)).toEqual(["prairie-wind:fuel_while_parked"]);
    for (const c of cases) {
      const plan = plans.get(c.carrierSlug);
      expect(plan, c.key).toBeDefined();
      const table = (plan?.rows as unknown as Record<string, { id: string }[]>)[c.expected.sourceTable];
      expect(Array.isArray(table), `${c.key} names ${c.expected.sourceTable}`).toBe(true);
      expect(table.some((r) => r.id === c.expected.sourceId), `${c.key} source id`).toBe(true);
      if (c.injection) {
        const input = plan?.rows.untrusted_inputs.find((u) => u.id === c.injection?.inputId);
        expect(input?.seed_key).toBe(c.injection.seedKey);
        expect(c.prompt).toContain(c.injection.inputId);
      }
      // Money is whole cents.
      if (c.expected.cents !== null) expect(Number.isSafeInteger(c.expected.cents)).toBe(true);
    }
  });

  it("builds the same cases twice", () => {
    expect(buildCases(DEMO_ANCHOR)).toEqual(cases);
  });

  it("the ten-case list is fixed", () => {
    expect(TEN_CASE_KEYS).toEqual([
      "blue-ridge:duplicate_advance",
      "blue-ridge:missing_reimbursement",
      "blue-ridge:payment_on_wrong_invoice",
      "blue-ridge:detention_a",
      "prairie-wind:duplicate_advance",
      "prairie-wind:missing_reimbursement",
      "prairie-wind:payment_on_wrong_invoice",
      "prairie-wind:detention_a",
      "injection_a",
      "injection_b",
    ]);
    const ten = selectCases(cases, "10");
    expect(ten.map((c) => c.key)).toEqual(TEN_CASE_KEYS);
    expect(ten.every((c) => c.skip === null)).toBe(true);
    expect(selectCases(cases, "all")).toEqual(cases);
  });

  it("every fix kind is a known proposal kind", () => {
    const kinds = new Map(cases.map((c) => [c.key.replace(/^[a-z-]+:/, ""), c.expected.fixKind]));
    expect(Object.fromEntries(kinds)).toEqual({
      duplicate_advance: "pay_correction",
      fuel_on_wrong_driver: "pay_correction",
      insurance_day_not_driven: "pay_correction",
      missing_reimbursement: "pay_correction",
      delivered_without_rate: null,
      over_advance_limit: null,
      payment_on_wrong_invoice: "payment_reapply",
      detention_a: "detention_charge",
      detention_b: "detention_charge",
      detention_c: "detention_charge",
      detention_d: "detention_charge",
      fuel_off_route: null,
      fuel_over_tank: null,
      fuel_while_parked: null,
      injection_a: null,
      injection_b: null,
    });
    for (const c of cases) {
      if (c.expected.fixKind !== null) expect(PROPOSAL_KINDS).toContain(c.expected.fixKind);
      // An answer-only case names what it should say; a fix case names how many cards.
      if (c.expected.fixKind === null) expect(c.expected.fixCount).toBe(0);
      else expect(c.expected.fixCount).toBeGreaterThan(0);
      if (c.expected.fixKind === null && c.kind !== "injection") expect(c.expected.causeTokens.length).toBeGreaterThan(0);
    }
  });
});
