import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blueRidgePlan } from "../agent/gateway/__tests__/plan-db";
import { heldByDriver } from "../data/read";
import {
  applyHeld,
  NOTHING_HELD,
  payDaysOf,
  settlementInputOf,
  type DeficitRow,
  type HeldRecoveries,
} from "../data/records";
import { outstandingCents } from "../rules-engine";
import { carriedItemDate } from "./paid";

// Balances drawn down across open weeks (D-090): what the driver's other unpaid stubs before a week
// hold counts as taken already, never past what is still owed, and a shortfall carried is dated
// in the earliest later week that still drafts it, else past any later week already settled.

const plan = blueRidgePlan();
const rows = plan.rows;
const open = rows.settlement_periods.find((p) => p.status === "open");
if (!open) throw new Error("the plan has no open week");
const period = { start: open.period_start, end: open.period_end };
const hero = rows.drivers.find((d) => d.code === "BR-D07");
if (!hero) throw new Error("the hero driver is missing");
const advance = rows.advances.find((a) => a.driver_id === hero.id && a.status === "paid" && a.recovered_cents === 0);
if (!advance) throw new Error("the hero has no outstanding advance");
const owed = advance.amount_cents + advance.fee_cents;

const held = (over: Partial<HeldRecoveries>): HeldRecoveries => ({ ...NOTHING_HELD, ...over });
const heroAdvance = (r: typeof rows) => r.advances.find((a) => a.id === advance.id)!;

describe("applyHeld", () => {
  it("changes nothing when nothing is held", () => {
    const same = applyHeld(rows, hero.id, NOTHING_HELD);
    expect(settlementInputOf(same, hero.id, period)).toEqual(settlementInputOf(rows, hero.id, period));
  });

  it("counts a held advance recovery as recovered, so the week takes only what is left", () => {
    const part = applyHeld(rows, hero.id, held({ advances: new Map([[advance.id, 5000]]) }));
    expect(heroAdvance(part).recovered_cents).toBe(5000);
    const input = settlementInputOf(part, hero.id, period);
    const read = input.advances.find((a) => a.id === advance.id)!;
    expect(outstandingCents(read)).toBe(owed - 5000);
  });

  it("caps a held advance recovery at the amount and fee less what a person took back", () => {
    const takenBack = { ...rows, advances: rows.advances.map((a) => (a.id === advance.id ? { ...a, taken_back_cents: 3000 } : a)) };
    const capped = applyHeld(takenBack, hero.id, held({ advances: new Map([[advance.id, owed * 2]]) }));
    expect(heroAdvance(capped).recovered_cents).toBe(owed - 3000);
    // checkAdvance accepts the capped record, and nothing is left to take.
    const read = settlementInputOf(capped, hero.id, period).advances.find((a) => a.id === advance.id)!;
    expect(outstandingCents(read)).toBe(0);
  });

  it("never lowers what the record says was recovered", () => {
    const recovered = { ...rows, advances: rows.advances.map((a) => (a.id === advance.id ? { ...a, recovered_cents: owed } : a)) };
    const out = applyHeld(recovered, hero.id, held({ advances: new Map([[advance.id, 100]]) }));
    expect(heroAdvance(out).recovered_cents).toBe(owed);
  });

  it("adds the held escrow to the driver's balance only, and leaves other drivers alone", () => {
    const out = applyHeld(rows, hero.id, held({ escrowCents: 2500 }));
    const before = rows.drivers.find((d) => d.id === hero.id)!.escrow_balance_cents;
    expect(out.drivers.find((d) => d.id === hero.id)!.escrow_balance_cents).toBe(before + 2500);
    for (const d of rows.drivers.filter((x) => x.id !== hero.id)) {
      expect(out.drivers.find((x) => x.id === d.id)).toBe(d);
    }
  });

  it("caps a held deficit recovery at the deficit's amount", () => {
    const deficit: DeficitRow = {
      id: randomUUID(),
      driver_id: hero.id,
      amount_cents: 30000,
      recovered_cents: 1000,
      created_at: "2026-10-28T15:00:00Z",
      created_on: "2026-10-28",
      source_kind: "ruling",
      note: "A load with no payment record",
    };
    const part = applyHeld({ ...rows, driver_deficits: [deficit] }, hero.id, held({ deficits: new Map([[deficit.id, 4000]]) }));
    expect(part.driver_deficits[0].recovered_cents).toBe(5000);
    const whole = applyHeld({ ...rows, driver_deficits: [deficit] }, hero.id, held({ deficits: new Map([[deficit.id, 90000]]) }));
    expect(whole.driver_deficits[0].recovered_cents).toBe(30000);
  });
});

describe("carriedItemDate", () => {
  it("is the day after the week in the normal order", () => {
    expect(carriedItemDate("2026-11-01", [])).toBe("2026-11-02");
  });

  it("walks past consecutive later weeks already settled for the driver", () => {
    const settled = [
      { start: "2026-11-09", end: "2026-11-15" },
      { start: "2026-11-02", end: "2026-11-08" },
    ];
    expect(carriedItemDate("2026-11-01", settled)).toBe("2026-11-16");
  });

  it("stops at the first unsettled week across a gap", () => {
    const settled = [
      { start: "2026-11-02", end: "2026-11-08" },
      { start: "2026-11-16", end: "2026-11-22" },
    ];
    expect(carriedItemDate("2026-11-01", settled)).toBe("2026-11-09");
  });

  it("is the first day of the earliest later week that still drafts it, across a week never opened", () => {
    expect(carriedItemDate("2026-11-01", [], "2026-11-09")).toBe("2026-11-09");
    expect(carriedItemDate("2026-11-01", [{ start: "2026-11-02", end: "2026-11-08" }], "2026-11-23")).toBe("2026-11-23");
  });

  it("refuses a drafting week that does not come after the week", () => {
    expect(() => carriedItemDate("2026-11-01", [], "2026-11-01")).toThrow(RangeError);
  });

  it("never falls before the week holding today, nor inside a later settled week", () => {
    // Booked in the week of November 16 with no week to draft it: not November 2, a week over
    // and never opened, but the week the next sweep start opens.
    expect(carriedItemDate("2026-11-01", [{ start: "2026-11-09", end: "2026-11-15" }], null, "2026-11-16")).toBe("2026-11-16");
    expect(
      carriedItemDate(
        "2026-11-01",
        [
          { start: "2026-11-09", end: "2026-11-15" },
          { start: "2026-11-16", end: "2026-11-22" },
        ],
        null,
        "2026-11-16",
      ),
    ).toBe("2026-11-23");
    // Booked in its own week or the next: the day after the week, as before.
    expect(carriedItemDate("2026-11-01", [], null, "2026-10-26")).toBe("2026-11-02");
    expect(carriedItemDate("2026-11-01", [], null, "2026-11-02")).toBe("2026-11-02");
  });
});

describe("heldByDriver", () => {
  const line = (driverId: string, kind: string, id: string, amount: number) => ({
    driver_id: driverId,
    kind,
    sources: JSON.stringify(kind === "escrow" ? [] : [{ table: kind === "advance_recovery" ? "advances" : "driver_deficits", id }]),
    amount_cents: String(amount),
  });

  it("sums every driver's held lines from one read, keyed by driver", () => {
    const [a, b, adv, def] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const out = heldByDriver([
      line(a.toUpperCase(), "advance_recovery", adv, -5000),
      line(a, "advance_recovery", adv, -2500),
      line(b, "deficit_recovery", def, -4000),
      line(b, "escrow", "", -1000),
    ]);
    expect(out?.get(a)?.advances.get(adv.toLowerCase())).toBe(7500);
    expect(out?.get(a)?.escrowCents).toBe(0);
    expect(out?.get(b)?.deficits.get(def.toLowerCase())).toBe(4000);
    expect(out?.get(b)?.escrowCents).toBe(1000);
    expect(heldByDriver([])?.size).toBe(0);
  });

  it("is unknown (null) when any driver's line does not read", () => {
    const [a, b] = [randomUUID(), randomUUID()];
    expect(heldByDriver([line(a, "escrow", "", -1000), { ...line(b, "advance_recovery", "", -500), sources: "[]" }])).toBeNull();
  });
});

describe("payDaysOf", () => {
  const company = rows.drivers.find((d) => d.worker_type === "company");
  if (!company) throw new Error("the plan has no company driver");
  const day = { id: randomUUID(), driver_id: company.id, day: "2026-12-01", source: "dispatch" as const, load_id: null };
  const only = (over: Partial<typeof rows>) => ({
    ...rows,
    loads: [],
    pay_items: [],
    deduction_schedules: [],
    driver_days: [day],
    ...over,
  });

  it("leaves out a day worked that makes no line on its own", () => {
    const config = rows.pay_configs.map((c) => ({ ...c, insurance_applies_to: "owner_operator" as const }));
    expect(payDaysOf(only({ pay_configs: config }))).toEqual([]);
  });

  it("keeps a day worked that draws a deduction the engine always takes", () => {
    const config = rows.pay_configs.map((c) => ({ ...c, insurance_applies_to: "all" as const, insurance_per_day_cents: 1500 }));
    expect(payDaysOf(only({ pay_configs: config, drivers: rows.drivers.map((d) => ({ ...d, own_insurance: false })) }))).toEqual([
      "2026-12-01",
    ]);
  });

  it("keeps a day whose pay rules do not read, as before", () => {
    expect(payDaysOf(only({ pay_configs: [] }))).toEqual(["2026-12-01"]);
  });

  it("leaves out a load not delivered", () => {
    const load = rows.loads.find((l) => l.driver_id !== null && l.delivered_on !== null)!;
    expect(payDaysOf(only({ driver_days: [], loads: [{ ...load, status: "in_transit" }] }))).toEqual([]);
    expect(payDaysOf(only({ driver_days: [], loads: [{ ...load, status: "delivered" }] }))).toEqual([load.delivered_on]);
  });
});
