import { describe, expect, it } from "vitest";
import {
  findDeliveredWithoutRate,
  findDuplicateAdvances,
  findFuelOnWrongDriver,
  findInsuranceDaysNotDriven,
  findMissingReimbursements,
  findOverAdvanceLimit,
  runAllChecks,
} from "./checks";
import {
  advance,
  BLUE_RIDGE,
  c,
  companyDriver,
  day,
  driver,
  item,
  load,
  PRAIRIE_WIND,
} from "./test-records";
import {
  InputError,
  type AdvanceRecord,
  type CheckInput,
  type DriverDayRecord,
  type FuelPurchaseRecord,
  type LoadRecord,
  type PayItemRecord,
} from "./types";

// A small invented tenant with nothing wrong in it: an insured owner-operator (drv-1, high
// advance limit) and an uninsured company driver (drv-2, the $500 tenant default).
const OWNER = "drv-1";
const COMPANY = "drv-2";

function purchase(over: Partial<FuelPurchaseRecord> & { id: string }): FuelPurchaseRecord {
  return {
    driverId: OWNER,
    loadId: "l1",
    purchasedAt: "2026-10-27T18:00:00Z",
    purchasedOn: "2026-10-27",
    state: "VA",
    gallonsMilli: 101_250,
    amountCents: c(38_000),
    paidWith: "company_card",
    purchaseRef: `fp-ref-${over.id}`,
    ...over,
  };
}

const lumper = (id: string, paidByDriver = true) => ({
  id,
  kind: "lumper" as const,
  seq: 1,
  amountCents: c(17_500),
  paidByDriver,
  description: null,
});

function clean(): CheckInput {
  return {
    config: BLUE_RIDGE,
    drivers: [
      driver({ id: OWNER, code: "T-D01", advanceLimitCents: c(100_000) }),
      companyDriver({ id: COMPANY, code: "T-D02" }),
    ],
    loads: [
      load({
        id: "l1",
        loadNumber: "T-L1",
        pickupOn: "2026-10-27",
        deliveredOn: "2026-10-28",
        accessorials: [lumper("acc-1"), lumper("acc-2", false)],
      }),
      load({ id: "l2", loadNumber: "T-L2", driverId: COMPANY, deliveredOn: "2026-10-29" }),
      load({
        id: "l3",
        loadNumber: "T-L3",
        status: "in_transit",
        pickupOn: "2026-10-29",
        deliveredOn: null,
        linehaulCents: null,
      }),
      load({
        id: "l4",
        loadNumber: "T-L4",
        status: "planned",
        driverId: null,
        pickupOn: "2026-11-03",
        deliveredOn: null,
        linehaulCents: null,
      }),
    ],
    days: [
      day("d1", "2026-10-27"),
      day("d2", "2026-10-28"),
      day("d3", "2026-10-29"),
      day("d4", "2026-10-30"),
      // The company driver is not insured at Blue Ridge, so a day off the road costs nothing.
      day("d5", "2026-10-31", { driverId: COMPANY }),
    ],
    fuelPurchases: [
      purchase({ id: "fp1" }),
      purchase({ id: "fp2", driverId: COMPANY, loadId: "l2" }),
      purchase({ id: "fp3", loadId: null, purchasedOn: "2026-10-30" }),
    ],
    items: [
      item({
        id: "i1",
        kind: "fuel",
        amountCents: c(38_000),
        refTable: "fuel_purchases",
        refId: "fp1",
      }),
      item({
        id: "i2",
        driverId: COMPANY,
        kind: "fuel",
        amountCents: c(38_000),
        refTable: "fuel_purchases",
        refId: "fp2",
      }),
      item({
        id: "i3",
        kind: "fuel",
        amountCents: c(38_000),
        refTable: "fuel_purchases",
        refId: "fp3",
      }),
      item({ id: "i4", amountCents: c(17_500), refTable: "load_accessorials", refId: "acc-1" }),
    ],
    advances: [
      advance({ id: "a1", driverId: OWNER, requestedAt: "2026-10-28T15:00:00Z" }),
      // Same driver, other amount, same hour: not a duplicate.
      advance({
        id: "a2",
        driverId: OWNER,
        amountCents: c(5_000),
        requestedAt: "2026-10-28T15:30:00Z",
      }),
      // Same amount and hour, other driver: not a duplicate.
      advance({ id: "a4", driverId: COMPANY, requestedAt: "2026-10-28T15:10:00Z" }),
      // Same driver, amount and hour, but never lent: not a duplicate, not owed.
      advance({
        id: "a5",
        driverId: OWNER,
        status: "rejected",
        requestedAt: "2026-10-28T16:00:00Z",
      }),
      advance({
        id: "a6",
        driverId: OWNER,
        status: "cancelled",
        requestedAt: "2026-10-28T17:00:00Z",
      }),
      advance({
        id: "a7",
        driverId: OWNER,
        status: "requested",
        requestedAt: "2026-10-28T18:00:00Z",
      }),
    ],
  };
}

type Plant = {
  advances?: AdvanceRecord[];
  loads?: LoadRecord[];
  days?: DriverDayRecord[];
  items?: PayItemRecord[];
  fuelPurchases?: FuelPurchaseRecord[];
};

function planted(plant: Plant, base: CheckInput = clean()): CheckInput {
  return {
    ...base,
    advances: [...base.advances, ...(plant.advances ?? [])],
    loads: [...base.loads, ...(plant.loads ?? [])],
    days: [...base.days, ...(plant.days ?? [])],
    items: [...base.items, ...(plant.items ?? [])],
    fuelPurchases: [...base.fuelPurchases, ...(plant.fuelPurchases ?? [])],
  };
}

// One planted problem per check, none of which trips another check.
const PLANTS: Record<string, Plant> = {
  duplicate: {
    advances: [advance({ id: "a-dup", driverId: OWNER, requestedAt: "2026-10-29T14:00:00Z" })],
  },
  fuel: {
    items: [
      item({
        id: "i-wrong",
        kind: "fuel",
        amountCents: c(41_200),
        itemRef: "ref-i-wrong",
        refTable: "fuel_purchases",
        refId: "fp2",
      }),
    ],
  },
  insurance: { days: [day("d-idle", "2026-10-25")] },
  reimbursement: {
    loads: [
      load({
        id: "l5",
        loadNumber: "T-L5",
        pickupOn: "2026-10-27",
        deliveredOn: "2026-10-27",
        accessorials: [lumper("acc-5")],
      }),
    ],
  },
  rate: {
    loads: [load({ id: "l6", loadNumber: "T-L6", driverId: COMPANY, linehaulCents: null })],
  },
  limit: {
    advances: [
      advance({
        id: "a-big",
        driverId: COMPANY,
        status: "approved",
        amountCents: c(34_000),
        feeCents: c(1_000),
        requestedAt: "2026-10-25T12:00:00Z",
        requestedOn: "2026-10-25",
      }),
    ],
  },
};

describe("the six checks on a clean tenant", () => {
  it("find nothing", () => {
    expect(runAllChecks(clean())).toEqual([]);
  });
});

describe("each planted problem is found exactly once, naming the record at fault first", () => {
  it.each([
    [
      "duplicate",
      {
        check: "duplicate_advance",
        category: "newer_is_duplicate",
        driverId: OWNER,
        amountCents: 20_000,
        sources: [
          { table: "advances", id: "a-dup" },
          { table: "advances", id: "a1" },
        ],
      },
    ],
    [
      "fuel",
      {
        check: "fuel_on_wrong_driver",
        category: "purchase_on_other_driver",
        driverId: OWNER,
        amountCents: 41_200,
        sources: [
          { table: "pay_items", id: "i-wrong" },
          { table: "fuel_purchases", id: "fp2" },
          { table: "loads", id: "l2" },
        ],
      },
    ],
    [
      "insurance",
      {
        check: "insurance_day_not_driven",
        category: "no_load_that_day",
        driverId: OWNER,
        amountCents: 1_100,
        sources: [{ table: "driver_days", id: "d-idle" }],
      },
    ],
    [
      "reimbursement",
      {
        check: "missing_reimbursement",
        category: "no_reimbursement",
        driverId: OWNER,
        amountCents: 17_500,
        sources: [
          { table: "load_accessorials", id: "acc-5" },
          { table: "loads", id: "l5" },
        ],
      },
    ],
    [
      "rate",
      {
        check: "delivered_without_rate",
        category: "rate_missing",
        driverId: COMPANY,
        sources: [{ table: "loads", id: "l6" }],
      },
    ],
    [
      "limit",
      {
        check: "over_advance_limit",
        category: "over_limit",
        driverId: COMPANY,
        amountCents: 5_000,
        sources: [
          { table: "drivers", id: COMPANY },
          { table: "advances", id: "a-big" },
          { table: "advances", id: "a4" },
        ],
      },
    ],
  ])("%s", (name, finding) => {
    expect(runAllChecks(planted(PLANTS[name]))).toEqual([finding]);
  });

  it("finds all six together, in the fixed order, whatever order the records arrive in", () => {
    const all = Object.values(PLANTS).reduce<CheckInput>(
      (acc, plant) => planted(plant, acc),
      clean(),
    );
    const found = runAllChecks(all);
    expect(found.map((f) => f.check)).toEqual([
      "duplicate_advance",
      "fuel_on_wrong_driver",
      "insurance_day_not_driven",
      "missing_reimbursement",
      "delivered_without_rate",
      "over_advance_limit",
    ]);
    const reversed = {
      ...all,
      drivers: [...all.drivers].reverse(),
      loads: [...all.loads].reverse(),
      days: [...all.days].reverse(),
      items: [...all.items].reverse(),
      fuelPurchases: [...all.fuelPurchases].reverse(),
      advances: [...all.advances].reverse(),
    };
    expect(runAllChecks(reversed)).toEqual(found);
  });
});

describe("duplicate advances", () => {
  it("includes a request exactly 24 hours later and leaves out one a second past that", () => {
    const found = findDuplicateAdvances(
      planted({
        advances: [
          advance({
            id: "a-8",
            driverId: COMPANY,
            status: "approved",
            requestedAt: "2026-10-29T15:10:00Z",
          }),
          advance({ id: "a-9", driverId: OWNER, requestedAt: "2026-10-29T15:00:01Z" }),
        ],
      }),
    );
    expect(found.map((f) => f.sources.map((s) => s.id))).toEqual([["a-8", "a4"]]);
  });
});

describe("fuel on the wrong driver", () => {
  it("flags a purchase on the driver's own card but another driver's load", () => {
    const found = findFuelOnWrongDriver(
      planted({
        fuelPurchases: [purchase({ id: "fp9", loadId: "l2" })],
        items: [item({ id: "i9", kind: "fuel", refTable: "fuel_purchases", refId: "fp9" })],
      }),
    );
    expect(found).toEqual([
      expect.objectContaining({
        category: "load_on_other_driver",
        sources: [
          { table: "pay_items", id: "i9" },
          { table: "fuel_purchases", id: "fp9" },
          { table: "loads", id: "l2" },
        ],
      }),
    ]);
  });

  it.each([
    ["no link at all", { refTable: null, refId: null }],
    ["a link to something else", { refTable: "load_accessorials" as const, refId: "fp1" }],
    ["a purchase the tenant does not have", { refTable: "fuel_purchases" as const, refId: "fp-x" }],
  ])("flags a fuel item with %s as not found", (_name, link) => {
    const found = findFuelOnWrongDriver(
      planted({ items: [item({ id: "i9", kind: "fuel", ...link })] }),
    );
    expect(found).toEqual([
      expect.objectContaining({
        category: "purchase_not_found",
        sources: [{ table: "pay_items", id: "i9" }],
      }),
    ]);
  });
});

describe("insurance days not driven", () => {
  it.each([
    ["the day before pickup", "2026-10-26", 1],
    ["the pickup day", "2026-10-27", 0],
    ["the delivery day", "2026-10-28", 0],
    ["a day while in transit", "2026-11-01", 0],
  ])("%s", (_name, date, count) => {
    const input = planted({ days: [day("d9", date)] });
    expect(findInsuranceDaysNotDriven(input)).toHaveLength(count);
  });

  it("does not count a planned load as on the road", () => {
    const input = planted({
      loads: [
        load({
          id: "l9",
          loadNumber: "T-L9",
          status: "planned",
          pickupOn: "2026-10-26",
          deliveredOn: null,
        }),
      ],
      days: [day("d9", "2026-10-26")],
    });
    const found = findInsuranceDaysNotDriven(input);
    expect(found.map((f) => f.sources[0].id)).toEqual(["d9"]);
  });

  it("never flags a day for a driver who carries their own insurance", () => {
    const base = clean();
    const exempt = { ...base, drivers: base.drivers.map((d) => ({ ...d, ownInsurance: true })) };
    expect(findInsuranceDaysNotDriven(planted({ days: [day("d9", "2026-10-26")] }, exempt))).toEqual([]);
    expect(findInsuranceDaysNotDriven({ ...exempt, config: PRAIRIE_WIND })).toEqual([]);
  });

  it("checks every driver where the tenant insures every driver", () => {
    const found = findInsuranceDaysNotDriven({ ...clean(), config: PRAIRIE_WIND });
    expect(found).toEqual([
      {
        check: "insurance_day_not_driven",
        category: "no_load_that_day",
        driverId: COMPANY,
        amountCents: 900,
        sources: [{ table: "driver_days", id: "d5" }],
      },
    ]);
  });

  it("refuses a day for a driver the input does not have", () => {
    const input = planted({ days: [day("d9", "2026-10-28", { driverId: "drv-x" })] });
    expect(() => findInsuranceDaysNotDriven(input)).toThrow(InputError);
  });
});

describe("missing reimbursements", () => {
  it("ignores a lumper on a load not yet delivered, and one reimbursed for another lumper", () => {
    const notDelivered = load({
      id: "l9",
      loadNumber: "T-L9",
      status: "in_transit",
      deliveredOn: null,
      accessorials: [lumper("acc-9")],
    });
    expect(findMissingReimbursements(planted({ loads: [notDelivered] }))).toEqual([]);
    const wrongRef = planted({
      loads: [load({ id: "l9", loadNumber: "T-L9", accessorials: [lumper("acc-9")] })],
      items: [
        item({ id: "i9", amountCents: c(17_500), refTable: "load_accessorials", refId: "acc-1x" }),
      ],
    });
    expect(findMissingReimbursements(wrongRef).map((f) => f.sources[0].id)).toEqual(["acc-9"]);
  });
});

describe("delivered without a rate", () => {
  it("flags an invoiced load with no rate too", () => {
    const input = planted({
      loads: [load({ id: "l9", loadNumber: "T-L9", status: "invoiced", linehaulCents: null })],
    });
    expect(findDeliveredWithoutRate(input).map((f) => f.sources[0].id)).toEqual(["l9"]);
  });
});

describe("over the advance limit", () => {
  it("counts the fee and only what is still owed", () => {
    const partly = planted({
      advances: [
        advance({
          id: "a9",
          driverId: COMPANY,
          amountCents: c(40_000),
          feeCents: c(1_000),
          recoveredCents: c(11_000),
          requestedAt: "2026-10-20T12:00:00Z",
          requestedOn: "2026-10-20",
        }),
      ],
    });
    // 20,000 + 41,000 - 11,000 = 50,000: at the limit, not over it.
    expect(findOverAdvanceLimit(partly)).toEqual([]);
  });

  it("refuses an advance for a driver the input does not have", () => {
    const input = planted({ advances: [advance({ id: "a9", driverId: "drv-x" })] });
    expect(() => findOverAdvanceLimit(input)).toThrow(InputError);
  });
});
