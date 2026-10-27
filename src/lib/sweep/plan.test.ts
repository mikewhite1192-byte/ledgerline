import { describe, expect, it } from "vitest";
import { checkInputOf, receivablesInputOf } from "../data/records";
import { findPaymentOnWrongInvoice, runAllChecks, type Finding } from "../rules-engine";
import { DEMO_CARRIERS } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { findingInWeek, findingKey, fixPlanFor, receivablesPlanFor, settlementPlanFor, type PlanLeg } from "./plan";

// The sweep's plan for the seeded week, to the cent: the engine's findings in, the legs out.

const ANCHOR = "2026-11-02";
const plan = buildCarrierPlan(DEMO_CARRIERS[0], ANCHOR);
const input = checkInputOf(plan.rows);
const openWeek = plan.periods[3];
const codeOf = (id: string | undefined) => plan.rows.drivers.find((d) => d.id === id)?.code;

function brief(legs: PlanLeg[]) {
  return legs.map((l) =>
    l.kind === "fix"
      ? [l.leg, "fix", codeOf(l.driverId), l.expectedCents, l.verdict, l.reasonCategories[0], l.payItemId ? "item" : "-"]
      : [l.leg, "person", l.text],
  );
}

describe("fixPlanFor on the seeded open week", () => {
  const findings = runAllChecks(input);
  const byCheck = new Map(findings.map((f) => [f.check, f]));

  it("plans the four fixable plants as signed integer-cent corrections", () => {
    expect(openWeek).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(brief(fixPlanFor(byCheck.get("duplicate_advance")!, input, openWeek))).toEqual([
      [1, "fix", "BR-D17", 34000, "owed_to_driver", "duplicate_charge", "-"],
    ]);
    expect(brief(fixPlanFor(byCheck.get("fuel_on_wrong_driver")!, input, openWeek))).toEqual([
      [1, "fix", "BR-D18", 28640, "owed_to_driver", "wrong_driver", "item"],
      [2, "fix", "BR-D05", -28640, "owed_by_driver", "wrong_driver", "-"],
    ]);
    expect(brief(fixPlanFor(byCheck.get("insurance_day_not_driven")!, input, openWeek))).toEqual([
      [1, "fix", "BR-D23", 1100, "owed_to_driver", "charge_not_owed", "-"],
    ]);
    expect(brief(fixPlanFor(byCheck.get("missing_reimbursement")!, input, openWeek))).toEqual([
      [1, "fix", "BR-D24", 17500, "owed_to_driver", "missing_reimbursement", "-"],
    ]);
  });

  it("sends the two plants with no engine fix to a person, in fixed words", () => {
    expect(brief(fixPlanFor(byCheck.get("delivered_without_rate")!, input, openWeek))).toEqual([
      [1, "person", "Load BR-L10259 delivered with no rate: enter the rate on the load."],
    ]);
    expect(brief(fixPlanFor(byCheck.get("over_advance_limit")!, input, openWeek))).toEqual([
      [1, "person", "Advances for BR-D16 are $150.00 over the driver's limit."],
    ]);
  });

  it("keeps every amount a safe integer and every leg's sources the finding's own", () => {
    for (const f of findings) {
      for (const leg of fixPlanFor(f, input, openWeek)) {
        expect(leg.sourceRefs).toEqual(f.sources.map((s) => ({ table: s.table, id: s.id })));
        if (leg.kind === "fix") expect(Number.isSafeInteger(leg.expectedCents)).toBe(true);
      }
    }
  });

  it("gives the same legs and keys on every run", () => {
    const again = buildCarrierPlan(DEMO_CARRIERS[0], ANCHOR);
    const againInput = checkInputOf(again.rows);
    const first = findings.map((f) => [findingKey(f, 1), fixPlanFor(f, input, openWeek)]);
    const second = runAllChecks(againInput).map((f) => [findingKey(f, 1), fixPlanFor(f, againInput, openWeek)]);
    expect(second).toEqual(first);
  });

  it("names the fuel item only while it is unsettled and inside the week", () => {
    const f = byCheck.get("fuel_on_wrong_driver")!;
    const lastWeek = plan.periods[2];
    const [leg] = fixPlanFor(f, input, lastWeek);
    expect(leg).toMatchObject({ kind: "fix", expectedCents: 28640 });
    expect(leg).not.toHaveProperty("payItemId");
    const itemId = f.sources.find((s) => s.table === "pay_items")!.id;
    const settled = { ...input, items: input.items.map((i) => (i.id === itemId ? { ...i, settlementId: "s" } : i)) };
    const [settledLeg] = fixPlanFor(f, settled, openWeek);
    expect(settledLeg).toMatchObject({ kind: "fix", expectedCents: 28640 });
    expect(settledLeg).not.toHaveProperty("payItemId");
  });

  it("sends the second leg to a person when the other driver is unknown", () => {
    const f = byCheck.get("fuel_on_wrong_driver")!;
    const purchaseId = f.sources.find((s) => s.table === "fuel_purchases")!.id;
    const orphan = {
      ...input,
      fuelPurchases: input.fuelPurchases.map((p) => (p.id === purchaseId ? { ...p, driverId: "nobody" } : p)),
    };
    expect(brief(fixPlanFor(f, orphan, openWeek))[1]).toEqual([
      2,
      "person",
      "Find who should carry the fuel charge moved off BR-D18.",
    ]);
  });

  it("never plans a fix on an amount the engine did not give", () => {
    const f = byCheck.get("duplicate_advance")!;
    for (const amountCents of [undefined, 0, -100, 10.5]) {
      const legs = fixPlanFor({ ...f, amountCents } as Finding, input, openWeek);
      expect(legs.map((l) => l.kind)).toEqual(["needs_person"]);
    }
  });
});

describe("findingInWeek", () => {
  const findings = runAllChecks(input);
  const byCheck = new Map(findings.map((f) => [f.check, f]));
  const lastWeek = plan.periods[2];
  const at = (f: Finding) => f.sources[0]!.id;
  const loadOf = (f: Finding) => f.sources.find((s) => s.table === "loads")!.id;

  it("keeps every seeded plant in its own open week and none in the week before", () => {
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect([f.check, findingInWeek(f, input, openWeek)]).toEqual([f.check, true]);
      const standing = f.check === "over_advance_limit";
      expect([f.check, findingInWeek(f, input, lastWeek)]).toEqual([f.check, standing]);
    }
  });

  it("leaves out a finding whose record at fault is dated before the week", () => {
    const before = "2026-10-12";
    const dup = byCheck.get("duplicate_advance")!;
    const fuel = byCheck.get("fuel_on_wrong_driver")!;
    const day = byCheck.get("insurance_day_not_driven")!;
    const reimb = byCheck.get("missing_reimbursement")!;
    const rate = byCheck.get("delivered_without_rate")!;
    const older = {
      ...input,
      advances: input.advances.map((a) => (a.id === at(dup) ? { ...a, requestedOn: before } : a)),
      items: input.items.map((i) => (i.id === at(fuel) ? { ...i, itemDate: before } : i)),
      days: input.days.map((d) => (d.id === at(day) ? { ...d, day: before } : d)),
      loads: input.loads.map((l) =>
        l.id === loadOf(reimb) || l.id === at(rate) ? { ...l, deliveredOn: before } : l,
      ),
    };
    for (const f of [dup, fuel, day, reimb, rate]) {
      expect([f.check, findingInWeek(f, older, openWeek)]).toEqual([f.check, false]);
    }
  });

  it("leaves out a finding whose day cannot be read", () => {
    const rate = byCheck.get("delivered_without_rate")!;
    const undated = { ...input, loads: input.loads.map((l) => (l.id === at(rate) ? { ...l, deliveredOn: null } : l)) };
    expect(findingInWeek(rate, undated, openWeek)).toBe(false);
    const dup = byCheck.get("duplicate_advance")!;
    expect(findingInWeek({ ...dup, sources: [{ table: "advances", id: "gone" }] }, input, openWeek)).toBe(false);
    expect(findingInWeek({ ...dup, sources: [] }, input, openWeek)).toBe(false);
  });
});

describe("findingKey", () => {
  it("is the check, category, record at fault and leg", () => {
    const f = runAllChecks(input).find((x) => x.check === "duplicate_advance")!;
    expect(findingKey(f, 2)).toBe(`duplicate_advance:newer_is_duplicate:advances:${f.sources[0].id}:2`);
    expect(() => findingKey({ ...f, sources: [] }, 1)).toThrow();
  });
});

describe("the person-only plans", () => {
  it("words the payment on the wrong invoice from its records", () => {
    const ar = receivablesInputOf(plan.rows, ANCHOR);
    const [f] = findPaymentOnWrongInvoice(ar);
    expect(brief(receivablesPlanFor(f, ar))).toEqual([
      [1, "person", "Payment BR-PAY-WRONG was applied to invoice BR-INV-10008; it matches invoice BR-INV-10014."],
    ]);
  });

  it("words a settlement exception with the driver's code", () => {
    const driver = plan.rows.drivers.find((d) => d.code === "BR-D07")!;
    const legs = settlementPlanFor({ category: "net_below_zero", settlementId: "s1", driverId: driver.id }, input);
    expect(brief(legs)).toEqual([[1, "person", "The pay run for BR-D07 comes out below zero."]]);
    expect(legs[0].sourceRefs).toEqual([{ table: "settlements", id: "s1" }]);
  });
});
