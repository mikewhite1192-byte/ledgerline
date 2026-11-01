import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blueRidgePlan } from "../agent/gateway/__tests__/plan-db";
import { applyHeld, NOTHING_HELD, settlementInputOf, type DeficitRow, type HeldRecoveries } from "../data/records";
import { outstandingCents } from "../rules-engine";
import { carriedItemDate } from "./paid";

// Balances drawn down across open weeks (D-090): what the driver's other unpaid stubs before a week
// hold counts as taken already, never past what is still owed, and a shortfall carried past a
// later week already settled is dated after it.

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
});
