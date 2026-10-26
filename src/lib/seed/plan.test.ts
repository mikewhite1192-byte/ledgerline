import { describe, expect, it } from "vitest";
import { loadsOf, payConfigOf } from "../data/records";
import type { AdvanceRow, DriverDayRow, DriverRow } from "../data/rows";
import { addDays } from "../time/local-date";
import { seededAdvanceDecision } from "./assert-plan";
import { DEMO_CARRIERS } from "./carriers";
import { buildCarrierPlan, type CarrierPlan } from "./plan";

const ANCHOR = "2026-11-02";
const plans = DEMO_CARRIERS.map((c) => buildCarrierPlan(c, ANCHOR));

// Every date and instant value in the plan.
function datesOf(plan: CarrierPlan): string[] {
  const r = plan.rows;
  return [
    ...r.loads.flatMap((l) => [l.pickup_on, l.delivered_on, l.delivered_at]),
    ...r.driver_days.map((d) => d.day),
    ...r.fuel_purchases.flatMap((f) => [f.purchased_on, f.purchased_at]),
    ...r.pay_items.map((p) => p.item_date),
    ...r.advances.flatMap((a) => [a.requested_on, a.requested_at, a.paid_at]),
    ...r.settlement_periods.map((p) => p.period_end),
    ...r.invoices.flatMap((i) => [i.issued_on, i.paid_on]),
    ...r.customer_payments.map((p) => p.received_on),
  ].filter((v): v is string => v !== null);
}

const plantedAdvanceIds = (plan: CarrierPlan) =>
  new Set([...plan.planted.duplicateAdvanceIds, ...plan.planted.overLimitAdvanceIds]);

describe("buildCarrierPlan", () => {
  it("gives the same rows and ids for the same anchor", () => {
    for (const c of DEMO_CARRIERS) {
      expect(buildCarrierPlan(c, ANCHOR)).toEqual(plans.find((p) => p.carrier === c));
    }
  });

  it("gives different ids for a different anchor", () => {
    const other = buildCarrierPlan(DEMO_CARRIERS[0], "2026-11-09");
    const ids = new Set(plans[0].rows.loads.map((l) => l.id));
    expect(other.rows.loads.some((l) => ids.has(l.id))).toBe(false);
  });

  it("keeps the two carriers' ids apart", () => {
    const ids = new Set(plans[0].rows.drivers.map((d) => d.id));
    expect(plans[1].rows.drivers.some((d) => ids.has(d.id))).toBe(false);
  });

  it("dates everything before the anchor", () => {
    for (const plan of plans) {
      // A local date is before the anchor; an instant (in UTC) is before the anchor's end.
      for (const v of datesOf(plan)) {
        expect(v.length === 10 ? v <= addDays(ANCHOR, -1) : v.slice(0, 10) <= ANCHOR).toBe(true);
      }
    }
  });

  it("plants nothing on the hero", () => {
    const plan = plans[0];
    const hero = plan.rows.drivers.find((d) => d.code === plan.carrier.heroCode) as DriverRow;
    const { planted, rows } = plan;
    const driverOfLoad = (id: string) => rows.loads.find((l) => l.id === id)?.driver_id;
    const lumper = rows.load_accessorials.find((a) => a.id === planted.unreimbursedLumperId);
    const touched = [
      ...rows.advances.filter((a) => plantedAdvanceIds(plan).has(a.id)).map((a) => a.driver_id),
      rows.pay_items.find((p) => p.id === planted.wrongDriverFuelItemId)?.driver_id,
      rows.fuel_purchases.find((f) => f.id === planted.wrongDriverPurchaseId)?.driver_id,
      rows.driver_days.find((d) => d.id === planted.dispatchDayId)?.driver_id,
      lumper ? driverOfLoad(lumper.load_id) : undefined,
      driverOfLoad(planted.noRateLoadId),
    ];
    expect(touched).toHaveLength(9);
    for (const id of touched) {
      expect(id).toBeDefined();
      expect(id).not.toBe(hero.id);
    }
    const codes = Object.values(plan.victims);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(hero.code);
  });

  it("leaves the insurance-day victim no load in transit from before the planted day", () => {
    for (const plan of plans) {
      const day = plan.rows.driver_days.find(
        (d) => d.id === plan.planted.dispatchDayId,
      ) as DriverDayRow;
      expect(day.source).toBe("dispatch");
      const carrying = plan.rows.loads.filter(
        (l) => l.driver_id === day.driver_id && l.status === "in_transit" && l.pickup_on <= day.day,
      );
      expect(carrying).toEqual([]);
    }
  });

  it("ties every fuel pay item to a fuel purchase", () => {
    for (const plan of plans) {
      const purchases = new Set(plan.rows.fuel_purchases.map((f) => f.id));
      const fuel = plan.rows.pay_items.filter((p) => p.kind === "fuel");
      expect(fuel.length).toBeGreaterThan(0);
      for (const p of fuel) {
        expect(p.ref_table).toBe("fuel_purchases");
        expect(purchases.has(p.ref_id as string)).toBe(true);
      }
    }
  });

  it("keeps every driver but the over-limit victim inside the advance limit, fee included", () => {
    for (const plan of plans) {
      const limitOf = (d: DriverRow) =>
        d.advance_limit_cents ?? plan.rows.pay_configs[0].advance_limit_default_cents;
      for (const d of plan.rows.drivers) {
        if (d.code === plan.victims.overLimit) continue;
        const open = plan.rows.advances
          .filter((a) => a.driver_id === d.id && (a.status === "approved" || a.status === "paid"))
          .reduce((n, a) => n + a.amount_cents + a.fee_cents - a.recovered_cents, 0);
        expect(open).toBeLessThanOrEqual(limitOf(d));
      }
    }
  });

  it("makes no duplicate advance but the planted pair", () => {
    for (const plan of plans) {
      const [a, b] = plan.planted.duplicateAdvanceIds;
      const pairs: string[] = [];
      const list = plan.rows.advances;
      for (const x of list) {
        for (const y of list) {
          const hours = (Date.parse(y.requested_at) - Date.parse(x.requested_at)) / 3_600_000;
          const same = x.driver_id === y.driver_id && x.amount_cents === y.amount_cents;
          if (x.id !== y.id && same && hours >= 0 && hours <= 24) pairs.push(`${x.id}>${y.id}`);
        }
      }
      expect(pairs).toEqual([`${a}>${b}`]);
    }
  });

  it("makes every advance that is not planted one the engine would approve", () => {
    for (const plan of plans) {
      const planted = plantedAdvanceIds(plan);
      const { rows } = plan;
      const loads = loadsOf(rows.loads, rows.load_state_miles, rows.load_accessorials);
      const clean = plan.rows.advances.filter((a) => !planted.has(a.id));
      expect(clean.length).toBeGreaterThanOrEqual(14);
      for (const a of clean) {
        const driver = plan.rows.drivers.find((d) => d.id === a.driver_id) as DriverRow;
        const prior: AdvanceRow[] = plan.rows.advances.filter(
          (x) => x.driver_id === a.driver_id && x.requested_at < a.requested_at,
        );
        const decision = seededAdvanceDecision({
          config: payConfigOf(plan.rows.pay_configs[0]),
          driver,
          loads,
          periods: plan.periods,
          zone: plan.carrier.timezone,
          at: a.requested_at,
          amountCents: a.amount_cents,
          prior,
        });
        expect({ code: driver.code, reasons: decision.reasons }).toEqual({
          code: driver.code,
          reasons: [],
        });
        expect(decision.eligible).toBe(true);
        expect(a.fee_cents).toBe(decision.feeCents);
      }
    }
  });

  it("builds and checks a plan for a spread of anchors, DST weeks included", () => {
    const anchors = Array.from({ length: 12 }, (_, i) => addDays("2026-01-05", i * 31));
    anchors.push("2026-03-09", "2026-11-03");
    for (const anchor of anchors) {
      for (const c of DEMO_CARRIERS) expect(() => buildCarrierPlan(c, anchor)).not.toThrow();
    }
  });
});
