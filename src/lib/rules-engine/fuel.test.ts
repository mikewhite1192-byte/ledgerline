import { describe, expect, it } from "vitest";
import {
  findFuelDuplicate,
  findFuelOffRoute,
  findFuelOverTank,
  findFuelWhileParked,
  overTankExcessCents,
  runFuelChecks,
  suggestedCorrection,
  type FuelLimits,
} from "./fuel";
import { BLUE_RIDGE, c, companyDriver, day, driver, item, load } from "./test-records";
import { InputError, type CheckInput, type FuelPurchaseRecord } from "./types";

// The four fuel checks over a small invented carrier: a company driver (drv-1) on a two-day
// Virginia load, with every amount the seed plants (36,575, 111,696, 43,896, 31,996 cents) so the
// arithmetic here is the arithmetic the demo shows.

const DRV = "drv-1";
const OTHER = "drv-2";

const LIMITS: FuelLimits = { from: "2026-10-27", duplicateWindowMinutes: 60, chargebackMaxCents: 50_000 };

function purchase(over: Partial<FuelPurchaseRecord> & { id: string }): FuelPurchaseRecord {
  return {
    driverId: DRV,
    loadId: "l1",
    purchasedAt: "2026-10-28T13:03:00Z",
    purchasedOn: "2026-10-28",
    state: "VA",
    gallonsMilli: 84_200,
    amountCents: c(31_996),
    paidWith: "company_card",
    purchaseRef: `fp-${over.id}`,
    ...over,
  };
}

// One Virginia load picked up on the 27th and delivered on the 28th, with a day row on each day.
function input(over: Partial<CheckInput> = {}): CheckInput {
  return {
    config: BLUE_RIDGE,
    drivers: [companyDriver({ id: DRV }), companyDriver({ id: OTHER, code: "T-D02", truckUnit: "T-102" })],
    loads: [load({ id: "l1", pickupOn: "2026-10-27", deliveredOn: "2026-10-28" })],
    days: [day("d1", "2026-10-27"), day("d2", "2026-10-28")],
    fuelPurchases: [],
    items: [],
    advances: [],
    ...over,
  };
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 28, 13, 3 + minute)).toISOString();

describe("fuel bought off the route", () => {
  const offRoute = purchase({ id: "p1", state: "FL", gallonsMilli: 95_000, amountCents: c(36_575) });

  it("charges a company-card fill-up in a state the load never crossed back in full", () => {
    const [f, ...rest] = findFuelOffRoute(input({ fuelPurchases: [offRoute] }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      check: "fuel_off_route",
      category: "state_not_on_route",
      driverId: DRV,
      amountCents: 36_575,
      findingKey: "fuel_off_route:p1",
      fuelPurchaseId: "p1",
      otherPurchaseId: null,
      loadId: "l1",
      payItemId: null,
      purchasedOn: "2026-10-28",
      state: "FL",
      gallonsMilli: 95_000,
      tankGallons: 200,
      paidWith: "company_card",
      excessCents: null,
      suggestedCents: -36_575,
      noSuggestion: null,
    });
    expect(f.sources).toEqual([
      { table: "fuel_purchases", id: "p1" },
      { table: "loads", id: "l1" },
      { table: "drivers", id: DRV },
    ]);
  });

  it("suggests nothing when the driver paid for the fuel", () => {
    const [f] = findFuelOffRoute(input({ fuelPurchases: [{ ...offRoute, paidWith: "driver_own" }] }));
    expect([f.suggestedCents, f.noSuggestion]).toEqual([null, "driver_paid"]);
  });

  it("suggests nothing when a fuel deduction already takes the fill-up from pay", () => {
    const deducted = item({ id: "i1", kind: "fuel", amountCents: c(36_575), refTable: "fuel_purchases", refId: "p1" });
    const [f] = findFuelOffRoute(input({ fuelPurchases: [offRoute], items: [deducted] }));
    expect([f.suggestedCents, f.noSuggestion, f.payItemId]).toEqual([null, "already_deducted", "i1"]);
    expect(f.sources.at(-1)).toEqual({ table: "pay_items", id: "i1" });
  });

  it("finds nothing in a state the load crossed, or outside the load's days", () => {
    const onRoute = purchase({ id: "p2", state: "VA" });
    const before = { ...offRoute, id: "p3", purchaseRef: "fp-p3", purchasedOn: "2026-10-26" };
    const after = { ...offRoute, id: "p4", purchaseRef: "fp-p4", purchasedOn: "2026-10-29" };
    expect(findFuelOffRoute(input({ fuelPurchases: [onRoute, before, after] }))).toEqual([]);
  });

  it("counts every day from pickup on while a load is still in transit", () => {
    const loads = [load({ id: "l1", status: "in_transit", pickupOn: "2026-10-27", deliveredOn: null })];
    const later = { ...offRoute, purchasedOn: "2026-10-30" };
    expect(findFuelOffRoute(input({ loads, fuelPurchases: [later] }))).toHaveLength(1);
  });

  it("skips a fill-up whose load is missing or was cancelled, never guessing", () => {
    expect(findFuelOffRoute(input({ fuelPurchases: [{ ...offRoute, loadId: "l9" }] }))).toEqual([]);
    const loads = [load({ id: "l1", status: "cancelled", pickupOn: "2026-10-27", deliveredOn: "2026-10-28" })];
    expect(findFuelOffRoute(input({ loads, fuelPurchases: [offRoute] }))).toEqual([]);
  });
});

describe("more fuel than the tank holds", () => {
  const over = purchase({ id: "p1", gallonsMilli: 286_400, amountCents: c(111_696) });

  it("shows the share of the price over the tank, rounded down, and suggests nothing (D2)", () => {
    const deduction = item({ id: "i1", kind: "fuel", amountCents: c(111_696), refTable: "fuel_purchases", refId: "p1" });
    const [f, ...rest] = findFuelOverTank(input({ fuelPurchases: [over], items: [deduction] }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      check: "fuel_over_tank",
      category: "gallons_over_tank",
      amountCents: 111_696,
      tankGallons: 200,
      excessCents: 33_696,
      payItemId: "i1",
      suggestedCents: null,
      noSuggestion: "over_tank",
    });
    expect(f.sources).toEqual([
      { table: "fuel_purchases", id: "p1" },
      { table: "drivers", id: DRV },
      { table: "pay_items", id: "i1" },
    ]);
  });

  it("finds nothing at exactly the tank, and uses each driver's own tank", () => {
    const full = purchase({ id: "p2", gallonsMilli: 200_000 });
    expect(findFuelOverTank(input({ fuelPurchases: [full] }))).toEqual([]);
    const drivers = [companyDriver({ id: DRV, tankGallons: 300 }), companyDriver({ id: OTHER, code: "T-D02" })];
    expect(findFuelOverTank(input({ drivers, fuelPurchases: [over] }))).toEqual([]);
  });

  it("rounds the excess down in whole cents", () => {
    // 111,696 x 86,400 / 286,400 = 33,696.0 exactly.
    expect(overTankExcessCents(111_696, 286_400, 200)).toBe(33_696);
    // 100 x 100,000 / 300,000 = 33.33...
    expect(overTankExcessCents(100, 300_000, 200)).toBe(33);
    // One thousandth of a gallon over: well under a cent.
    expect(overTankExcessCents(1_000, 200_001, 200)).toBe(0);
    expect(overTankExcessCents(1_000, 150_000, 200)).toBe(0);
  });
});

describe("fuel bought on a day off", () => {
  const parked = purchase({
    id: "p1",
    loadId: null,
    purchasedOn: "2026-10-31",
    purchasedAt: "2026-11-01T02:40:00Z",
    gallonsMilli: 118_000,
    amountCents: c(43_896),
  });

  it("charges a company-card fill-up with no load on the road and no day row back in full (D1)", () => {
    const [f, ...rest] = findFuelWhileParked(input({ fuelPurchases: [parked] }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      check: "fuel_while_parked",
      category: "no_load_or_day",
      amountCents: 43_896,
      loadId: null,
      suggestedCents: -43_896,
      noSuggestion: null,
    });
    expect(f.sources).toEqual([
      { table: "fuel_purchases", id: "p1" },
      { table: "drivers", id: DRV },
    ]);
  });

  it("finds nothing on a day with a day row, a load on the road, or the driver's own card", () => {
    const withDay = input({ fuelPurchases: [parked], days: [day("d9", "2026-10-31")] });
    expect(findFuelWhileParked(withDay)).toEqual([]);
    const onLoad = input({
      fuelPurchases: [parked],
      loads: [load({ id: "l2", pickupOn: "2026-10-30", deliveredOn: "2026-11-01" })],
    });
    expect(findFuelWhileParked(onLoad)).toEqual([]);
    expect(findFuelWhileParked(input({ fuelPurchases: [{ ...parked, paidWith: "driver_own" }] }))).toEqual([]);
  });

  it("does not count another driver's load, or a cancelled one, as on the road", () => {
    const loads = [
      load({ id: "l2", driverId: OTHER, pickupOn: "2026-10-30", deliveredOn: "2026-11-01" }),
      load({ id: "l3", status: "cancelled", pickupOn: "2026-10-30", deliveredOn: "2026-11-01" }),
    ];
    expect(findFuelWhileParked(input({ loads, fuelPurchases: [parked] }))).toHaveLength(1);
  });

  it("suggests nothing when a fuel deduction already takes the fill-up from pay", () => {
    const deducted = item({ id: "i1", kind: "fuel", amountCents: c(43_896), refTable: "fuel_purchases", refId: "p1" });
    const [f] = findFuelWhileParked(input({ fuelPurchases: [parked], items: [deducted] }));
    expect([f.suggestedCents, f.noSuggestion, f.payItemId]).toEqual([null, "already_deducted", "i1"]);
  });
});

describe("the same receipt turned in twice", () => {
  const older = purchase({ id: "pa", paidWith: "driver_own", purchasedAt: at(0) });
  const payback = (id: string, refId: string) =>
    item({ id, kind: "reimbursement", subkind: "fuel", amountCents: c(31_996), refTable: "fuel_purchases", refId });

  const pair = (gapMinutes: number, over: Partial<FuelPurchaseRecord> = {}) => [
    older,
    purchase({ id: "pb", paidWith: "driver_own", purchasedAt: at(gapMinutes), ...over }),
  ];

  it("takes back the second payback when the driver was paid back twice", () => {
    const items = [payback("ia", "pa"), payback("ib", "pb")];
    const [f, ...rest] = findFuelDuplicate(input({ fuelPurchases: pair(6), items }), 60);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      check: "fuel_duplicate",
      category: "same_fill_twice",
      amountCents: 31_996,
      findingKey: "fuel_duplicate:pb:pa",
      fuelPurchaseId: "pb",
      otherPurchaseId: "pa",
      payItemId: "ib",
      suggestedCents: -31_996,
      noSuggestion: null,
    });
    expect(f.sources).toEqual([
      { table: "fuel_purchases", id: "pb" },
      { table: "fuel_purchases", id: "pa" },
      { table: "pay_items", id: "ib" },
    ]);
  });

  it("counts a gap of up to the window, never one minute more", () => {
    expect(findFuelDuplicate(input({ fuelPurchases: pair(59) }), 60)).toHaveLength(1);
    expect(findFuelDuplicate(input({ fuelPurchases: pair(60) }), 60)).toHaveLength(1);
    expect(findFuelDuplicate(input({ fuelPurchases: pair(61) }), 60)).toEqual([]);
  });

  it("needs the same gallons, amount, state and driver", () => {
    expect(findFuelDuplicate(input({ fuelPurchases: pair(6, { gallonsMilli: 84_201 }) }), 60)).toEqual([]);
    expect(findFuelDuplicate(input({ fuelPurchases: pair(6, { amountCents: c(31_997) }) }), 60)).toEqual([]);
    expect(findFuelDuplicate(input({ fuelPurchases: pair(6, { state: "MD" }) }), 60)).toEqual([]);
    expect(findFuelDuplicate(input({ fuelPurchases: pair(6, { driverId: OTHER }) }), 60)).toEqual([]);
  });

  it("lists a pair nobody paid back twice with no suggestion, saying why", () => {
    const [own] = findFuelDuplicate(input({ fuelPurchases: pair(6) }), 60);
    expect([own.suggestedCents, own.noSuggestion, own.payItemId]).toEqual([null, "not_paid_back", null]);
    const card = [
      { ...older, paidWith: "company_card" as const },
      purchase({ id: "pb", purchasedAt: at(6) }),
    ];
    const [swipe] = findFuelDuplicate(input({ fuelPurchases: card }), 60);
    expect([swipe.suggestedCents, swipe.noSuggestion]).toEqual([null, "card_double_charge"]);
  });

  it("never takes back more than the second payback paid: a part payback lists its line and suggests nothing", () => {
    const part = item({ id: "ib", kind: "reimbursement", subkind: "fuel", amountCents: c(20_000), refTable: "fuel_purchases", refId: "pb" });
    for (const paidWith of ["driver_own", "company_card"] as const) {
      const records = [{ ...older, paidWith }, purchase({ id: "pb", paidWith, purchasedAt: at(6) })];
      const [f, ...rest] = findFuelDuplicate(input({ fuelPurchases: records, items: [payback("ia", "pa"), part] }), 60);
      expect(rest).toEqual([]);
      expect([f.suggestedCents, f.noSuggestion, f.payItemId, f.amountCents]).toEqual([null, "not_paid_back", "ib", 31_996]);
      expect(f.sources).toEqual([
        { table: "fuel_purchases", id: "pb" },
        { table: "fuel_purchases", id: "pa" },
        { table: "pay_items", id: "ib" },
      ]);
    }
    // A payback of more than the fill-up is not taken back by the fill-up's amount either.
    const over = { ...part, amountCents: c(31_997) };
    const [more] = findFuelDuplicate(input({ fuelPurchases: pair(6), items: [over] }), 60);
    expect([more.suggestedCents, more.noSuggestion, more.payItemId]).toEqual([null, "not_paid_back", "ib"]);
    // A whole payback is still taken back in full, through the limit, by runFuelChecks too.
    const [whole] = runFuelChecks(input({ fuelPurchases: pair(6), items: [payback("ib", "pb")] }), LIMITS).filter(
      (f) => f.check === "fuel_duplicate",
    );
    expect([whole.suggestedCents, whole.noSuggestion, whole.payItemId]).toEqual([-31_996, null, "ib"]);
  });

  it("names the newer of each pair, whatever order the records arrive in", () => {
    const third = purchase({ id: "pc", paidWith: "driver_own", purchasedAt: at(12) });
    const records = [third, ...pair(6)];
    const found = findFuelDuplicate(input({ fuelPurchases: records }), 60);
    expect(found.map((f) => f.findingKey)).toEqual([
      "fuel_duplicate:pb:pa",
      "fuel_duplicate:pc:pa",
      "fuel_duplicate:pc:pb",
    ]);
    expect(findFuelDuplicate(input({ fuelPurchases: [...records].reverse() }), 60)).toEqual(found);
  });
});

describe("all four together", () => {
  const offRoute = purchase({ id: "p1", state: "FL", gallonsMilli: 95_000, amountCents: c(36_575), purchasedAt: at(-600) });
  const over = purchase({ id: "p2", gallonsMilli: 286_400, amountCents: c(111_696), purchasedAt: at(-300) });
  const parked = purchase({ id: "p3", loadId: null, purchasedOn: "2026-10-31", purchasedAt: "2026-11-01T02:40:00Z", gallonsMilli: 118_000, amountCents: c(43_896) });
  const dupA = purchase({ id: "p4", paidWith: "driver_own", purchasedAt: at(0) });
  const dupB = purchase({ id: "p5", paidWith: "driver_own", purchasedAt: at(6) });
  const items = [
    item({ id: "i4", kind: "reimbursement", subkind: "fuel", amountCents: c(31_996), refTable: "fuel_purchases", refId: "p4" }),
    item({ id: "i5", kind: "reimbursement", subkind: "fuel", amountCents: c(31_996), refTable: "fuel_purchases", refId: "p5" }),
  ];
  const all = input({ fuelPurchases: [dupB, parked, over, dupA, offRoute], items });

  it("lists them in a fixed order with the engine's numbers", () => {
    const found = runFuelChecks(all, LIMITS);
    expect(found.map((f) => [f.check, f.fuelPurchaseId, f.amountCents, f.suggestedCents, f.noSuggestion])).toEqual([
      ["fuel_off_route", "p1", 36_575, -36_575, null],
      ["fuel_over_tank", "p2", 111_696, null, "over_tank"],
      ["fuel_while_parked", "p3", 43_896, -43_896, null],
      ["fuel_duplicate", "p5", 31_996, -31_996, null],
    ]);
  });

  it("never lists a fill-up before the start date", () => {
    const found = runFuelChecks(all, { ...LIMITS, from: "2026-10-29" });
    expect(found.map((f) => f.fuelPurchaseId)).toEqual(["p3"]);
  });

  it("offers no correction above the limit, so a person handles it by hand", () => {
    const found = runFuelChecks(all, { ...LIMITS, chargebackMaxCents: 40_000 });
    expect(found.map((f) => [f.suggestedCents, f.noSuggestion])).toEqual([
      [-36_575, null],
      [null, "over_tank"],
      [null, "over_limit"],
      [-31_996, null],
    ]);
    expect(suggestedCorrection({ suggestedCents: c(-40_000), noSuggestion: null }, { chargebackMaxCents: 40_000 })).toEqual({
      suggestedCents: -40_000,
      noSuggestion: null,
    });
    expect(() => runFuelChecks(all, { ...LIMITS, chargebackMaxCents: 0 })).toThrow(InputError);
  });

  it("passes a wrong-driver fill-up that fits its own load, tank and day", () => {
    // As the seed plants it: a company-card fill-up by drv-2 on drv-2's own load, deducted from
    // drv-1. The wrong-driver check finds it; none of the four fuel rules do.
    const loads = [load({ id: "l2", driverId: OTHER, pickupOn: "2026-10-27", deliveredOn: "2026-10-28" })];
    const p = purchase({ id: "p9", driverId: OTHER, loadId: "l2", gallonsMilli: 71_600, amountCents: c(28_640) });
    const deducted = item({ id: "i9", kind: "fuel", amountCents: c(28_640), refTable: "fuel_purchases", refId: "p9" });
    expect(runFuelChecks(input({ loads, fuelPurchases: [p], items: [deducted] }), LIMITS)).toEqual([]);
  });
});

describe("a broken read", () => {
  it("throws rather than return a clean result", () => {
    const stranger = purchase({ id: "p1", driverId: "drv-x" });
    expect(() => runFuelChecks(input({ fuelPurchases: [stranger] }), LIMITS)).toThrow(InputError);
    const noTank = input({ drivers: [driver({ id: DRV, tankGallons: 0 })] });
    expect(() => findFuelOverTank(noTank)).toThrow(InputError);
    expect(() => findFuelOffRoute(input({ fuelPurchases: [purchase({ id: "p1", state: "Va" })] }))).toThrow(InputError);
    expect(() => findFuelOffRoute(input({ fuelPurchases: [purchase({ id: "p1", gallonsMilli: 0 })] }))).toThrow(InputError);
    expect(() => findFuelDuplicate(input(), -1)).toThrow(InputError);
    expect(() => runFuelChecks(input(), { ...LIMITS, from: "10/27/2026" })).toThrow(InputError);
  });
});
