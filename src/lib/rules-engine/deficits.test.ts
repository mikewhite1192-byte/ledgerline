import { describe, expect, it } from "vitest";
import { checkDeficit, recoverDeficits } from "./recovery";
import { settleDriver } from "./settlement";
import { advance, BLUE_RIDGE, c, driver, DRIVER_ID, load, PRAIRIE_WIND } from "./test-records";
import { InputError, type DeficitRecord, type SettlementInput, type SettlementResult } from "./types";

// Deficit recovery (S6b): money a person ruled the driver owes, taken back from pay after the
// advances, oldest first, inside the one cap the advances share and the room the floor leaves.

const WEEK = { start: "2026-10-26", end: "2026-11-01" };
const PW_WEEK = { start: "2026-10-25", end: "2026-10-31" };

function deficit(over: Partial<DeficitRecord> & { id: string }): DeficitRecord {
  return {
    driverId: DRIVER_ID,
    amountCents: c(10_000),
    recoveredCents: c(0),
    createdAt: "2026-10-27T15:00:00Z",
    createdOn: "2026-10-27",
    sourceKind: "ruling",
    note: "Card 4417 load with no payment record",
    ...over,
  };
}

function input(over: Partial<SettlementInput> = {}): SettlementInput {
  return {
    config: BLUE_RIDGE,
    driver: driver(),
    period: WEEK,
    loads: [],
    days: [],
    items: [],
    schedules: [],
    advances: [],
    deficits: [],
    escrowBalanceCents: c(0),
    ...over,
  };
}

const lineSum = (r: SettlementResult, kind: string) =>
  r.lines.filter((l) => l.kind === kind).reduce((n, l) => n + l.amountCents, 0);

function holds(r: SettlementResult) {
  expect(r.grossCents - r.deductionsCents + r.carryForwardCents).toBe(r.netCents);
  expect(r.netCents).toBeGreaterThanOrEqual(0);
  expect(lineSum(r, "deficit_recovery") + r.deficitRecoveries.reduce((n, d) => n + d.cents, 0)).toBe(0);
}

describe("recoverDeficits", () => {
  it("takes the oldest first by when it was booked, then by id, and a part of the next", () => {
    const out = recoverDeficits(
      BLUE_RIDGE,
      [
        deficit({ id: "d-late", createdAt: "2026-10-29T15:00:00Z", createdOn: "2026-10-29" }),
        deficit({ id: "d-b", createdAt: "2026-10-27T15:00:00Z" }),
        deficit({ id: "d-a", createdAt: "2026-10-27T15:00:00Z" }),
      ],
      WEEK,
      c(25_000),
      c(0),
    );
    expect(out.recoveries).toEqual([
      { deficitId: "d-a", cents: 10_000 },
      { deficitId: "d-b", cents: 10_000 },
      { deficitId: "d-late", cents: 5_000 },
    ]);
    expect(out.recoveredCents).toBe(25_000);
    expect(out.lines.map((l) => [l.kind, l.amountCents, l.sources])).toEqual([
      ["deficit_recovery", -10_000, [{ table: "driver_deficits", id: "d-a" }]],
      ["deficit_recovery", -10_000, [{ table: "driver_deficits", id: "d-b" }]],
      ["deficit_recovery", -5_000, [{ table: "driver_deficits", id: "d-late" }]],
    ]);
    // Only the newest still owes; the room (the floor) was the limit.
    expect(out.note).toEqual({
      kind: "deficit_recovery",
      category: "floor",
      sources: [{ table: "driver_deficits", id: "d-late" }],
      amountCents: 5_000,
    });
  });

  it("shares the one cap with the advances: what they took this period comes off it first", () => {
    const deficits = [deficit({ id: "d1", amountCents: c(20_000) })];
    const some = recoverDeficits(PRAIRIE_WIND, deficits, PW_WEEK, c(100_000), c(20_000));
    expect(some.recoveredCents).toBe(5_000);
    expect(some.note).toMatchObject({ category: "cap", amountCents: 15_000 });
    const none = recoverDeficits(PRAIRIE_WIND, deficits, PW_WEEK, c(100_000), c(25_000));
    expect(none.recoveredCents).toBe(0);
    expect(none.lines).toEqual([]);
    expect(none.note).toEqual({
      kind: "deficit_recovery",
      category: "cap",
      sources: [{ table: "driver_deficits", id: "d1" }],
      amountCents: 20_000,
    });
    // With no cap, only the room limits it.
    expect(recoverDeficits(BLUE_RIDGE, deficits, WEEK, c(100_000), c(90_000)).recoveredCents).toBe(20_000);
  });

  it("names the floor when the room is the tighter limit, and takes nothing from room below zero", () => {
    const deficits = [deficit({ id: "d1", amountCents: c(20_000) })];
    const tight = recoverDeficits(PRAIRIE_WIND, deficits, PW_WEEK, c(3_000), c(0));
    expect(tight.recoveredCents).toBe(3_000);
    expect(tight.note).toMatchObject({ category: "floor", amountCents: 17_000 });
    const below = recoverDeficits(BLUE_RIDGE, deficits, WEEK, c(-5_000) as never, c(0));
    expect(below.recoveredCents).toBe(0);
    expect(below.note).toMatchObject({ category: "floor", amountCents: 20_000 });
  });

  it("leaves out a deficit booked after the period's last day", () => {
    const out = recoverDeficits(
      BLUE_RIDGE,
      [
        deficit({ id: "d-in", createdOn: "2026-11-01", createdAt: "2026-11-02T04:00:00Z" }),
        deficit({ id: "d-after", createdOn: "2026-11-02", createdAt: "2026-11-02T15:00:00Z" }),
      ],
      WEEK,
      c(100_000),
      c(0),
    );
    expect(out.recoveries).toEqual([{ deficitId: "d-in", cents: 10_000 }]);
    expect(out.note).toBeNull();
  });

  it("takes only what is still owed, and nothing from a deficit already recovered", () => {
    const out = recoverDeficits(
      BLUE_RIDGE,
      [
        deficit({ id: "d-done", recoveredCents: c(10_000) }),
        deficit({ id: "d-part", amountCents: c(10_000), recoveredCents: c(6_500) }),
      ],
      WEEK,
      c(100_000),
      c(0),
    );
    expect(out.recoveries).toEqual([{ deficitId: "d-part", cents: 3_500 }]);
    expect(out.note).toBeNull();
    expect(recoverDeficits(BLUE_RIDGE, [], WEEK, c(100_000), c(0))).toEqual({
      lines: [],
      recoveries: [],
      note: null,
      recoveredCents: 0,
    });
  });

  it("labels the line with the start of the deficit's note", () => {
    const long = "Card 4417 pull-back the card could not cover in full, load BR-L2041";
    const out = recoverDeficits(BLUE_RIDGE, [deficit({ id: "d1", note: long })], WEEK, c(100_000), c(0));
    expect(out.lines[0].label).toBe(`Owed: ${long.slice(0, 40)}`);
  });
});

describe("checkDeficit", () => {
  it("fails closed on a record it cannot trust", () => {
    expect(() => checkDeficit(deficit({ id: "d1" }), "drv-other")).toThrow(InputError);
    expect(() => checkDeficit(deficit({ id: "d1", amountCents: c(0) }))).toThrow(InputError);
    expect(() => checkDeficit(deficit({ id: "d1", recoveredCents: c(10_001) }))).toThrow(InputError);
    expect(() => checkDeficit(deficit({ id: "d1", note: "" }))).toThrow(InputError);
    expect(() => checkDeficit(deficit({ id: "d1", sourceKind: "other" as never }))).toThrow(InputError);
    expect(() => checkDeficit(deficit({ id: "d1", createdOn: "11/01/2026" }))).toThrow(InputError);
    expect(() => checkDeficit(deficit({ id: "d1", amountCents: 10.5 as never }))).toThrow();
    expect(checkDeficit(deficit({ id: "d1" }), DRIVER_ID).id).toBe("d1");
  });
});

describe("settleDriver: deficits after the advances", () => {
  it("takes a deficit after the advances inside the room the floor leaves, and the identity holds", () => {
    const r = settleDriver(
      input({
        loads: [load({ id: "l1", linehaulCents: c(100_000), deliveredOn: "2026-10-28" })],
        advances: [advance({ id: "a1", amountCents: c(20_000) })],
        deficits: [deficit({ id: "d1", amountCents: c(15_000) })],
      }),
    );
    holds(r);
    const kinds = r.lines.map((l) => l.kind);
    expect(kinds.indexOf("deficit_recovery")).toBeGreaterThan(kinds.lastIndexOf("advance_recovery"));
    expect(r.deficitRecoveries).toEqual([{ deficitId: "d1", cents: 15_000 }]);
    expect(r.netCents).toBeGreaterThanOrEqual(BLUE_RIDGE.netPayFloorCents);
  });

  it("stops at the floor and notes what is still owed", () => {
    const r = settleDriver(
      input({
        loads: [load({ id: "l1", linehaulCents: c(60_000), deliveredOn: "2026-10-28" })],
        deficits: [deficit({ id: "d1", amountCents: c(90_000) })],
      }),
    );
    holds(r);
    expect(r.netCents).toBe(BLUE_RIDGE.netPayFloorCents);
    const taken = r.deficitRecoveries[0]?.cents ?? 0;
    expect(taken).toBeLessThan(90_000);
    expect(r.notes).toContainEqual({
      kind: "deficit_recovery",
      category: "floor",
      sources: [{ table: "driver_deficits", id: "d1" }],
      amountCents: 90_000 - taken,
    });
  });

  it("takes nothing from deficits once the advances used the whole cap", () => {
    const r = settleDriver(
      input({
        config: PRAIRIE_WIND,
        period: PW_WEEK,
        loads: [load({ id: "l1", linehaulCents: c(200_000), deliveredOn: "2026-10-27" })],
        advances: [advance({ id: "a1", amountCents: c(30_000) })],
        deficits: [deficit({ id: "d1" })],
      }),
    );
    holds(r);
    expect(-lineSum(r, "advance_recovery")).toBe(25_000);
    expect(r.deficitRecoveries).toEqual([]);
    expect(r.notes).toContainEqual({
      kind: "deficit_recovery",
      category: "cap",
      sources: [{ table: "driver_deficits", id: "d1" }],
      amountCents: 10_000,
    });
  });

  it("refuses two deficits with one id and another driver's deficit", () => {
    expect(() => settleDriver(input({ deficits: [deficit({ id: "d1" }), deficit({ id: "d1" })] }))).toThrow(
      InputError,
    );
    expect(() => settleDriver(input({ deficits: [deficit({ id: "d1", driverId: "drv-2" })] }))).toThrow(InputError);
  });

  it("changes nothing for a driver with no deficits", () => {
    const base = input({ loads: [load({ id: "l1", linehaulCents: c(100_000), deliveredOn: "2026-10-28" })] });
    const r = settleDriver(base);
    holds(r);
    expect(r.lines.some((l) => l.kind === "deficit_recovery")).toBe(false);
    expect(r.deficitRecoveries).toEqual([]);
  });
});
