import { describe, expect, it } from "vitest";
import {
  fleetMpgMilliOf,
  iftaQuarter,
  taxableMilliOf,
  taxCentsOf,
  type IftaInput,
  type IftaRate,
} from "./ifta";
import { c, load } from "./test-records";
import { InputError, type FuelPurchaseRecord, type LoadRecord } from "./types";

// The IFTA quarter over the design's hand-checked example (design-ifta 2): every figure below was
// worked by hand from the integers, so a change to any rounding step shows here.

const Q4 = { start: "2026-10-01", end: "2026-12-31" };

const RATES: IftaRate[] = [
  { state: "NC", rateMcents: 36_300 },
  { state: "SC", rateMcents: 28_000 },
  { state: "GA", rateMcents: 35_000 },
  { state: "VA", rateMcents: 30_000 },
];

function purchase(over: Partial<FuelPurchaseRecord> & { id: string }): FuelPurchaseRecord {
  return {
    driverId: "drv-1",
    loadId: null,
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

const sm = (loadId: string, rows: Array<[string, number]>) =>
  rows.map(([state, miles], i) => ({ id: `${loadId}-sm${i + 1}`, state, miles }));

function exampleLoads(): LoadRecord[] {
  return [
    load({ id: "L1", loadNumber: "L-1001", loadedMiles: 1_900, emptyMiles: 100, stateMiles: sm("L1", [["NC", 1_000], ["SC", 500], ["GA", 500]]) }),
    load({ id: "L2", loadNumber: "L-1002", loadedMiles: 1_000, emptyMiles: 0, stateMiles: sm("L2", [["NC", 600], ["VA", 400]]) }),
    load({ id: "L3", loadNumber: "L-1003", loadedMiles: 500, emptyMiles: 0, stateMiles: [] }),
    load({ id: "L4", loadNumber: "L-1004", deliveredOn: "2026-09-30", pickupOn: "2026-09-29", loadedMiles: 700, stateMiles: sm("L4", [["NC", 700]]) }),
    load({ id: "L5", loadNumber: "L-1005", status: "in_transit", deliveredOn: null, loadedMiles: 800, stateMiles: sm("L5", [["SC", 800]]) }),
  ];
}

function exampleFuel(): FuelPurchaseRecord[] {
  return [
    purchase({ id: "F1", state: "NC", gallonsMilli: 300_000 }),
    purchase({ id: "F2", state: "GA", gallonsMilli: 100_000 }),
    purchase({ id: "F3", state: "VA", gallonsMilli: 50_500 }),
    purchase({ id: "F4", state: "NC", gallonsMilli: 90_000, purchasedOn: "2026-09-30", purchasedAt: "2026-09-30T15:00:00Z" }),
  ];
}

const example = (over: Partial<IftaInput> = {}): IftaInput => ({
  loads: exampleLoads(),
  fuel: exampleFuel(),
  rates: RATES,
  ...over,
});

describe("iftaQuarter: the hand-checked example", () => {
  const result = iftaQuarter(example(), Q4);

  it("counts the quarter's loads and fuel, leaving out the gap load and the rows outside it", () => {
    expect(result.quarter).toEqual(Q4);
    expect(result.loadsCounted).toBe(2);
    expect(result.purchasesCounted).toBe(3);
    expect(result.totalMiles).toBe(3_000);
    expect(result.totalGallonsMilli).toBe(450_500);
  });

  it("rounds the fleet MPG once: 3,000 miles / 450.500 gallons is 6.659", () => {
    expect(result.fleetMpgMilli).toBe(6_659);
  });

  it("gives every state's taxable gallons, net gallons and tax exactly", () => {
    expect(result.states).toEqual([
      { state: "GA", miles: 500, taxPaidGallonsMilli: 100_000, taxableGallonsMilli: 75_086, netGallonsMilli: -24_914, rateMcents: 35_000, taxCents: -872 },
      { state: "NC", miles: 1_600, taxPaidGallonsMilli: 300_000, taxableGallonsMilli: 240_276, netGallonsMilli: -59_724, rateMcents: 36_300, taxCents: -2_168 },
      { state: "SC", miles: 500, taxPaidGallonsMilli: 0, taxableGallonsMilli: 75_086, netGallonsMilli: 75_086, rateMcents: 28_000, taxCents: 2_102 },
      { state: "VA", miles: 400, taxPaidGallonsMilli: 50_500, taxableGallonsMilli: 60_069, netGallonsMilli: 9_569, rateMcents: 30_000, taxCents: 287 },
    ]);
  });

  it("sums the totals from the state figures without rounding again", () => {
    expect(result.totals).toEqual({
      miles: 3_000,
      taxPaidGallonsMilli: 450_500,
      taxableGallonsMilli: 450_517,
      netGallonsMilli: 17,
      taxCents: -651,
    });
    expect(result.statesWithoutRate).toBe(0);
  });

  it("lists the load with no state split and the miles it leaves out", () => {
    expect(result.gaps).toEqual([{ kind: "no_state_split", loadId: "L3", loadNumber: "L-1003", miles: 500 }]);
    expect(result.excludedMiles).toBe(500);
  });

  it("names South Carolina as the largest tax due", () => {
    expect(result.largestTaxDue).toEqual({ state: "SC", taxCents: 2_102 });
  });
});

describe("the three rounding steps", () => {
  it("rounds tax half away from zero: 1 milli at 500,000 is 1 cent, and -1 milli is -1 cent", () => {
    expect(taxCentsOf(1, 500_000)).toBe(1);
    expect(taxCentsOf(-1, 500_000)).toBe(-1);
    expect(taxCentsOf(1, 499_999)).toBe(0);
    expect(Object.is(taxCentsOf(-1, 499_999), 0)).toBe(true);
    expect(taxCentsOf(0, 36_300)).toBe(0);
  });

  it("rounds taxable gallons half up: 1 mile at 16.000 MPG is 0.063 gallons", () => {
    expect(taxableMilliOf(1, 16_000)).toBe(63);
    expect(taxableMilliOf(0, 16_000)).toBe(0);
    expect(taxableMilliOf(1_600, 6_659)).toBe(240_276);
  });

  it("rounds the fleet MPG half up, and leaves it unknown with no gallons or no miles", () => {
    expect(fleetMpgMilliOf(3_000, 450_500)).toBe(6_659);
    // 1 mile / 0.003 gallons is 333.3333 MPG, rounded down; 1 / 2,000.000 is 0.0005, rounded up.
    expect(fleetMpgMilliOf(1, 3)).toBe(333_333);
    expect(fleetMpgMilliOf(5, 800)).toBe(6_250);
    expect(fleetMpgMilliOf(1, 2_000_000)).toBe(1);
    expect(fleetMpgMilliOf(3_000, 0)).toBeNull();
    expect(fleetMpgMilliOf(0, 450_500)).toBeNull();
  });

  it("refuses a fleet MPG that rounds to zero rather than dividing by it", () => {
    expect(() => fleetMpgMilliOf(1, 2_000_001)).toThrow(InputError);
  });
});

describe("gaps fail visible", () => {
  it("with no fuel in the quarter, MPG, taxable, net and tax are unknown, never zero", () => {
    const r = iftaQuarter(example({ fuel: [] }), Q4);
    expect(r.fleetMpgMilli).toBeNull();
    expect(r.totals).toEqual({ miles: 3_000, taxPaidGallonsMilli: 0, taxableGallonsMilli: null, netGallonsMilli: null, taxCents: null });
    for (const s of r.states) {
      expect(s.taxableGallonsMilli).toBeNull();
      expect(s.netGallonsMilli).toBeNull();
      expect(s.taxCents).toBeNull();
      expect(s.miles).toBeGreaterThan(0);
    }
    expect(r.largestTaxDue).toBeNull();
  });

  it("with fuel but no counted miles, the MPG is unknown and the purchases still list", () => {
    const r = iftaQuarter(example({ loads: [] }), Q4);
    expect(r.fleetMpgMilli).toBeNull();
    expect(r.states.map((s) => [s.state, s.taxPaidGallonsMilli, s.taxCents])).toEqual([
      ["GA", 100_000, null],
      ["NC", 300_000, null],
      ["VA", 50_500, null],
    ]);
    expect(r.totals.taxCents).toBeNull();
  });

  it("leaves out a load whose split does not add up, listing it with its miles", () => {
    const loads = [
      ...exampleLoads(),
      load({ id: "L6", loadNumber: "L-1000", loadedMiles: 600, stateMiles: sm("L6", [["NC", 300], ["SC", 200]]) }),
    ];
    const r = iftaQuarter(example({ loads }), Q4);
    expect(r.gaps).toEqual([
      { kind: "state_miles_mismatch", loadId: "L6", loadNumber: "L-1000", miles: 600 },
      { kind: "no_state_split", loadId: "L3", loadNumber: "L-1003", miles: 500 },
    ]);
    expect(r.excludedMiles).toBe(1_100);
    expect(r.totalMiles).toBe(3_000);
    expect(r.loadsCounted).toBe(2);
  });

  it("keeps a state with no rate on its row, without a rate or tax, and the tax total leaves it out", () => {
    const loads = [
      ...exampleLoads(),
      load({ id: "L7", loadNumber: "L-1007", loadedMiles: 300, stateMiles: sm("L7", [["AK", 300]]) }),
    ];
    const r = iftaQuarter(example({ loads }), Q4);
    const ak = r.states.find((s) => s.state === "AK");
    expect(ak).toMatchObject({ miles: 300, taxPaidGallonsMilli: 0, rateMcents: null, taxCents: null });
    expect(ak?.taxableGallonsMilli).toBeGreaterThan(0);
    expect(ak?.netGallonsMilli).toBe(ak?.taxableGallonsMilli);
    expect(r.statesWithoutRate).toBe(1);
    expect(r.gaps).toContainEqual({ kind: "state_not_in_rates", state: "AK", miles: 300, taxPaidGallonsMilli: 0 });
    const withRate = r.states.filter((s) => s.rateMcents !== null);
    expect(r.totals.taxCents).toBe(withRate.reduce((t, s) => t + (s.taxCents ?? 0), 0));
    expect(r.totals.miles).toBe(3_300);
  });

  it("with only states that have no rate, the tax total is zero and says how many it left out", () => {
    const r = iftaQuarter(example({ rates: [{ state: "TX", rateMcents: 20_000 }] }), Q4);
    expect(r.totals.taxCents).toBe(0);
    expect(r.statesWithoutRate).toBe(4);
    expect(r.largestTaxDue).toBeNull();
  });

  it("ignores a load delivered before the quarter, one in transit, and fuel bought before it", () => {
    const r = iftaQuarter(example(), Q4);
    expect(r.gaps.map((g) => (g.kind === "state_not_in_rates" ? g.state : g.loadId))).toEqual(["L3"]);
    expect(r.states.find((s) => s.state === "NC")?.miles).toBe(1_600);
    expect(r.states.find((s) => s.state === "NC")?.taxPaidGallonsMilli).toBe(300_000);
  });

  it("counts the quarter's last day and not the next quarter's first", () => {
    const loads = [
      load({ id: "E1", loadNumber: "L-2001", pickupOn: "2026-12-30", deliveredOn: "2026-12-31", loadedMiles: 100, stateMiles: sm("E1", [["VA", 100]]) }),
      load({ id: "E2", loadNumber: "L-2002", pickupOn: "2026-12-31", deliveredOn: "2027-01-01", loadedMiles: 200, stateMiles: sm("E2", [["VA", 200]]) }),
    ];
    const fuel = [
      purchase({ id: "G1", purchasedOn: "2026-10-01", gallonsMilli: 10_000 }),
      purchase({ id: "G2", purchasedOn: "2027-01-01", gallonsMilli: 20_000 }),
    ];
    const r = iftaQuarter({ loads, fuel, rates: RATES }, Q4);
    expect(r.totalMiles).toBe(100);
    expect(r.totalGallonsMilli).toBe(10_000);
  });
});

describe("largest tax due", () => {
  it("is the largest positive tax, the first by state code on a tie", () => {
    const loads = [load({ id: "T1", loadedMiles: 1_000, stateMiles: sm("T1", [["VA", 500], ["SC", 500]]) })];
    const fuel = [purchase({ id: "T1F", state: "TX", gallonsMilli: 100_000 })];
    const rates = [
      { state: "VA", rateMcents: 30_000 },
      { state: "SC", rateMcents: 30_000 },
      { state: "TX", rateMcents: 20_000 },
    ];
    const r = iftaQuarter({ loads, fuel, rates }, Q4);
    expect(r.states.map((s) => s.state)).toEqual(["SC", "TX", "VA"]);
    expect(r.largestTaxDue?.state).toBe("SC");
    expect(r.largestTaxDue?.taxCents).toBe(r.states.find((s) => s.state === "VA")?.taxCents);
  });
});

describe("refusals", () => {
  it("refuses a rate list naming a state twice", () => {
    expect(() => iftaQuarter(example({ rates: [...RATES, { state: "NC", rateMcents: 30_000 }] }), Q4)).toThrow(InputError);
  });

  it("refuses a rate outside 1 to 200,000 thousandths of a cent", () => {
    for (const rateMcents of [0, -1, 200_001, 1.5, Number.NaN]) {
      expect(() => iftaQuarter(example({ rates: [{ state: "NC", rateMcents }] }), Q4)).toThrow(InputError);
    }
    expect(() => iftaQuarter(example({ rates: [{ state: "NC", rateMcents: 200_000 }] }), Q4)).not.toThrow();
  });

  it("refuses a state code that is not two capital letters, on a rate, a state row or a purchase", () => {
    expect(() => iftaQuarter(example({ rates: [{ state: "nc", rateMcents: 30_000 }] }), Q4)).toThrow(InputError);
    const badRow = [load({ id: "B1", stateMiles: [{ id: "B1-sm1", state: "Va", miles: 500 }] })];
    expect(() => iftaQuarter(example({ loads: badRow }), Q4)).toThrow(InputError);
    expect(() => iftaQuarter(example({ fuel: [purchase({ id: "B2", state: "VAX" })] }), Q4)).toThrow(InputError);
    expect(() => iftaQuarter(example({ fuel: [purchase({ id: "B3", state: "" })] }), Q4)).toThrow(InputError);
  });

  it("refuses a quarter that ends before it starts", () => {
    expect(() => iftaQuarter(example(), { start: "2026-12-31", end: "2026-10-01" })).toThrow(InputError);
  });

  it("refuses a purchase with no gallons, and a load or purchase listed twice", () => {
    expect(() => iftaQuarter(example({ fuel: [purchase({ id: "Z", gallonsMilli: 0 })] }), Q4)).toThrow(InputError);
    expect(() => iftaQuarter(example({ fuel: [...exampleFuel(), purchase({ id: "F1" })] }), Q4)).toThrow(InputError);
    expect(() => iftaQuarter(example({ loads: [...exampleLoads(), load({ id: "L1" })] }), Q4)).toThrow(InputError);
  });
});
