import { describe, expect, it } from "vitest";
import { localDateOf } from "../time/local-date";
import { settleDriver } from "./settlement";
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
  schedule,
} from "./test-records";
import {
  ConfigError,
  InputError,
  type PayConfig,
  type SettlementInput,
  type SettlementResult,
} from "./types";

const WEEK = { start: "2026-10-26", end: "2026-11-01" };
const PW_WEEK = { start: "2026-10-25", end: "2026-10-31" };

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
    escrowBalanceCents: c(0),
    ...over,
  };
}

const weekdays = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];

// The POLISH-DEPLOY worked example: Blue Ridge driver BR-D07, owner-operator who owns the truck,
// 75% of linehaul, escrow balance $1,300 of $2,000. Records from the week before are included to
// show they stay out.
const HERO: SettlementInput = input({
  driver: driver({ id: "drv-hero", code: "BR-D07", escrowBalanceCents: c(130_000) }),
  loads: [
    load({
      id: "hero-l0",
      loadNumber: "BR-L2038",
      driverId: "drv-hero",
      pickupOn: "2026-10-23",
      deliveredOn: "2026-10-25",
      linehaulCents: c(90_000),
    }),
    load({
      id: "hero-l1",
      loadNumber: "BR-L2041",
      driverId: "drv-hero",
      pickupOn: "2026-10-26",
      deliveredOn: "2026-10-27",
      linehaulCents: c(110_000),
      fuelSurchargeCents: c(14_000),
    }),
    load({
      id: "hero-l2",
      loadNumber: "BR-L2042",
      driverId: "drv-hero",
      pickupOn: "2026-10-28",
      deliveredOn: "2026-10-29",
      linehaulCents: c(130_000),
      fuelSurchargeCents: c(16_500),
    }),
    load({
      id: "hero-l3",
      loadNumber: "BR-L2043",
      driverId: "drv-hero",
      pickupOn: "2026-10-30",
      deliveredOn: "2026-10-30",
      linehaulCents: c(80_000),
      fuelSurchargeCents: c(9_500),
    }),
  ],
  days: weekdays.map((d, i) => day(`hero-d${i + 1}`, d, { driverId: "drv-hero" })),
  items: [
    item({
      id: "hero-i0",
      driverId: "drv-hero",
      subkind: "toll",
      amountCents: c(2_000),
      itemDate: "2026-10-25",
    }),
    item({
      id: "hero-i1",
      driverId: "drv-hero",
      subkind: "fuel",
      amountCents: c(10_000),
      itemDate: "2026-10-27",
    }),
    item({
      id: "hero-i2",
      driverId: "drv-hero",
      subkind: "toll",
      amountCents: c(4_500),
      itemDate: "2026-10-28",
    }),
    item({
      id: "hero-i3",
      driverId: "drv-hero",
      subkind: "toll",
      amountCents: c(3_500),
      itemDate: "2026-10-30",
    }),
  ],
  schedules: [schedule({ id: "hero-esc", driverId: "drv-hero", activeFrom: "2026-10-05" })],
  advances: [
    advance({
      id: "hero-adv",
      driverId: "drv-hero",
      requestedAt: "2026-10-28T15:10:00Z",
      requestedOn: "2026-10-28",
    }),
  ],
  escrowBalanceCents: c(130_000),
});

describe("settleDriver: the hero's week", () => {
  it("reproduces the worked example to the cent, every line citing its records", () => {
    const result = settleDriver(HERO);
    expect(result.lines).toEqual([
      {
        seq: 1,
        kind: "load_pay",
        label: "Load BR-L2041",
        amountCents: 82_500,
        sources: [{ table: "loads", id: "hero-l1" }],
        meta: { basis: "percent", percentBase: "linehaul", baseCents: 110_000, percentBps: 7_500 },
      },
      {
        seq: 2,
        kind: "load_pay",
        label: "Load BR-L2042",
        amountCents: 97_500,
        sources: [{ table: "loads", id: "hero-l2" }],
        meta: { basis: "percent", percentBase: "linehaul", baseCents: 130_000, percentBps: 7_500 },
      },
      {
        seq: 3,
        kind: "load_pay",
        label: "Load BR-L2043",
        amountCents: 60_000,
        sources: [{ table: "loads", id: "hero-l3" }],
        meta: { basis: "percent", percentBase: "linehaul", baseCents: 80_000, percentBps: 7_500 },
      },
      {
        seq: 4,
        kind: "reimbursement",
        label: "Reimbursement (fuel)",
        amountCents: 10_000,
        sources: [{ table: "pay_items", id: "hero-i1" }],
      },
      {
        seq: 5,
        kind: "reimbursement",
        label: "Reimbursement (toll)",
        amountCents: 4_500,
        sources: [{ table: "pay_items", id: "hero-i2" }],
      },
      {
        seq: 6,
        kind: "reimbursement",
        label: "Reimbursement (toll)",
        amountCents: 3_500,
        sources: [{ table: "pay_items", id: "hero-i3" }],
      },
      {
        seq: 7,
        kind: "insurance",
        label: "Insurance, 5 days",
        amountCents: -5_500,
        sources: [1, 2, 3, 4, 5].map((n) => ({ table: "driver_days", id: `hero-d${n}` })),
        meta: { days: 5, perDayCents: 1_100 },
      },
      {
        seq: 8,
        kind: "escrow",
        label: "Escrow",
        amountCents: -10_000,
        sources: [{ table: "deduction_schedules", id: "hero-esc" }],
        meta: { balanceBeforeCents: 130_000, targetCents: 200_000 },
      },
      {
        seq: 9,
        kind: "advance_recovery",
        label: "Advance recovery (2026-10-28)",
        amountCents: -20_000,
        sources: [{ table: "advances", id: "hero-adv" }],
      },
    ]);
    expect(result).toMatchObject({
      exceptions: [],
      notes: [],
      grossCents: 258_000,
      deductionsCents: 35_500,
      netCents: 222_500,
      carryForwardCents: 0,
      recoveries: [{ advanceId: "hero-adv", cents: 20_000 }],
      escrowDeltaCents: 10_000,
      insuredDays: 5,
    });
  });

  it("matches the panel's five numbers", () => {
    const r = settleDriver(HERO);
    const total = (...kinds: string[]) =>
      r.lines.filter((l) => kinds.includes(l.kind)).reduce((s, l) => s + l.amountCents, 0);
    expect(total("load_pay")).toBe(240_000);
    expect(total("reimbursement")).toBe(18_000);
    expect(total("advance_recovery")).toBe(-20_000);
    expect(total("insurance")).toBe(-5_500);
    expect(total("escrow")).toBe(-10_000);
    expect(r.netCents).toBe(222_500);
  });

  it("gives the same answer whatever order the records arrive in", () => {
    const shuffled = {
      ...HERO,
      loads: [...HERO.loads].reverse(),
      days: [...HERO.days].reverse(),
      items: [...HERO.items].reverse(),
    };
    expect(settleDriver(shuffled)).toEqual(settleDriver(HERO));
  });
});

type Expected = {
  lines: [string, number][];
  gross: number;
  deductions: number;
  net: number;
  carry?: number;
  exceptions?: string[];
  notes?: [string, string, number][];
  recoveries?: [string, number][];
  escrowDelta?: number;
  insuredDays?: number;
};

const percentLoad = (id: string, linehaul: number, over = {}) =>
  load({ id, linehaulCents: c(linehaul), ...over });

const CASES: [string, SettlementInput, Expected][] = [
  [
    "a driver with no loads and no days gets an empty result, not an error",
    input({ driver: companyDriver() }),
    { lines: [], gross: 0, deductions: 0, net: 0, insuredDays: 0 },
  ],
  [
    "escrow at target takes nothing and says so",
    input({
      loads: [percentLoad("a", 100_000)],
      schedules: [schedule({ id: "esc" })],
      escrowBalanceCents: c(200_000),
    }),
    {
      lines: [["load_pay", 75_000]],
      gross: 75_000,
      deductions: 0,
      net: 75_000,
      notes: [["escrow", "at_target", 10_000]],
    },
  ],
  [
    "escrow tops up only to the target",
    input({
      loads: [percentLoad("a", 100_000)],
      schedules: [schedule({ id: "esc" })],
      escrowBalanceCents: c(195_000),
    }),
    {
      lines: [
        ["load_pay", 75_000],
        ["escrow", -5_000],
      ],
      gross: 75_000,
      deductions: 5_000,
      net: 70_000,
      notes: [["escrow", "at_target", 5_000]],
      escrowDelta: 5_000,
    },
  ],
  [
    "a driver's own escrow target wins over the tenant's",
    input({
      loads: [percentLoad("a", 100_000)],
      schedules: [schedule({ id: "esc", targetCents: c(50_000) })],
      escrowBalanceCents: c(45_000),
    }),
    {
      lines: [
        ["load_pay", 75_000],
        ["escrow", -5_000],
      ],
      gross: 75_000,
      deductions: 5_000,
      net: 70_000,
      notes: [["escrow", "at_target", 5_000]],
      escrowDelta: 5_000,
    },
  ],
  [
    "escrow is limited by the net pay floor",
    input({ loads: [percentLoad("a", 50_000)], schedules: [schedule({ id: "esc" })] }),
    {
      lines: [
        ["load_pay", 37_500],
        ["escrow", -7_500],
      ],
      gross: 37_500,
      deductions: 7_500,
      net: 30_000,
      notes: [["escrow", "floor", 2_500]],
      escrowDelta: 7_500,
    },
  ],
  [
    "a week under the floor pays what is left and takes no escrow or recovery",
    input({
      loads: [percentLoad("a", 30_000)],
      schedules: [schedule({ id: "esc" })],
      advances: [advance({ id: "adv" })],
    }),
    {
      lines: [["load_pay", 22_500]],
      gross: 22_500,
      deductions: 0,
      net: 22_500,
      notes: [
        ["escrow", "floor", 10_000],
        ["advance_recovery", "floor", 20_000],
      ],
    },
  ],
  [
    "an advance bigger than the week's earnings is recovered down to the floor, the rest stays out",
    input({
      loads: [percentLoad("a", 60_000)],
      advances: [advance({ id: "adv", amountCents: c(50_000) })],
    }),
    {
      lines: [
        ["load_pay", 45_000],
        ["advance_recovery", -15_000],
      ],
      gross: 45_000,
      deductions: 15_000,
      net: 30_000,
      notes: [["advance_recovery", "floor", 35_000]],
      recoveries: [["adv", 15_000]],
    },
  ],
  [
    "Prairie Wind recovers at most $250 a settlement, oldest advance first, fee included",
    input({
      config: PRAIRIE_WIND,
      period: PW_WEEK,
      loads: [percentLoad("a", 200_000, { deliveredOn: "2026-10-27" })],
      advances: [
        advance({
          id: "newer",
          requestedAt: "2026-10-28T15:00:00Z",
          amountCents: c(15_000),
          feeCents: c(500),
        }),
        advance({
          id: "older",
          requestedAt: "2026-10-26T15:00:00Z",
          requestedOn: "2026-10-26",
          amountCents: c(20_000),
          feeCents: c(500),
        }),
      ],
    }),
    {
      lines: [
        ["load_pay", 150_000],
        ["advance_recovery", -20_500],
        ["advance_recovery", -4_500],
      ],
      gross: 150_000,
      deductions: 25_000,
      net: 125_000,
      notes: [["advance_recovery", "cap", 11_000]],
      recoveries: [
        ["older", 20_500],
        ["newer", 4_500],
      ],
    },
  ],
  [
    "a partly recovered advance owes only the rest",
    input({
      loads: [percentLoad("a", 200_000)],
      advances: [advance({ id: "adv", amountCents: c(30_000), recoveredCents: c(25_000) })],
    }),
    {
      lines: [
        ["load_pay", 150_000],
        ["advance_recovery", -5_000],
      ],
      gross: 150_000,
      deductions: 5_000,
      net: 145_000,
      recoveries: [["adv", 5_000]],
    },
  ],
  [
    "advances not yet paid, refused, or requested after the period are not recovered",
    input({
      loads: [percentLoad("a", 200_000)],
      advances: [
        advance({ id: "approved", status: "approved" }),
        advance({ id: "rejected", status: "rejected" }),
        advance({ id: "later", requestedAt: "2026-11-02T15:00:00Z", requestedOn: "2026-11-02" }),
      ],
    }),
    { lines: [["load_pay", 150_000]], gross: 150_000, deductions: 0, net: 150_000 },
  ],
  [
    "hard deductions past gross give net 0 and carry the rest forward, with no escrow or recovery",
    input({
      loads: [percentLoad("a", 40_000)],
      days: [day("d1", "2026-10-27"), day("d2", "2026-10-28")],
      schedules: [
        schedule({ id: "lease", kind: "lease", amountCents: c(50_000) }),
        schedule({ id: "esc" }),
      ],
      advances: [advance({ id: "adv" })],
    }),
    {
      lines: [
        ["load_pay", 30_000],
        ["lease", -50_000],
        ["insurance", -2_200],
      ],
      gross: 30_000,
      deductions: 52_200,
      net: 0,
      carry: 22_200,
      exceptions: ["net_below_zero"],
      insuredDays: 2,
    },
  ],
  [
    "hard deductions in paystub order: fuel, other, shortfall, lease, scheduled, insurance",
    input({
      loads: [percentLoad("a", 200_000)],
      days: [day("d1", "2026-10-28")],
      items: [
        item({ id: "short", kind: "carried_shortfall", amountCents: c(2_200) }),
        item({ id: "scale", kind: "other_deduction", subkind: "scale", amountCents: c(1_300) }),
        item({ id: "fuel", kind: "fuel", amountCents: c(28_640) }),
        item({ id: "toll", kind: "reimbursement", subkind: "toll", amountCents: c(1_800) }),
      ],
      schedules: [
        schedule({ id: "eld", kind: "other", amountCents: c(1_500) }),
        schedule({ id: "lease", kind: "lease", amountCents: c(47_500) }),
        schedule({ id: "old-lease", kind: "lease", activeTo: "2026-10-25" }),
      ],
    }),
    {
      lines: [
        ["load_pay", 150_000],
        ["reimbursement", 1_800],
        ["fuel", -28_640],
        ["other_deduction", -1_300],
        ["carried_shortfall", -2_200],
        ["lease", -47_500],
        ["other_deduction", -1_500],
        ["insurance", -1_100],
      ],
      gross: 151_800,
      deductions: 82_240,
      net: 69_560,
      insuredDays: 1,
    },
  ],
  [
    "a day is charged once even when two rows share a date",
    input({ days: [day("d1", "2026-10-27"), day("d2", "2026-10-27"), day("d3", "2026-10-28")] }),
    {
      lines: [["insurance", -2_200]],
      gross: 0,
      deductions: 2_200,
      net: 0,
      carry: 2_200,
      exceptions: ["net_below_zero"],
      insuredDays: 2,
    },
  ],
  [
    "Blue Ridge charges insurance to owner-operators only",
    input({
      driver: companyDriver(),
      loads: [load({ id: "a" })],
      days: [day("d1", "2026-10-28")],
    }),
    { lines: [["load_pay", 31_000]], gross: 31_000, deductions: 0, net: 31_000, insuredDays: 0 },
  ],
  [
    "Prairie Wind charges insurance to every driver",
    input({
      config: PRAIRIE_WIND,
      period: PW_WEEK,
      driver: companyDriver(),
      loads: [load({ id: "a" })],
      days: [day("d1", "2026-10-28")],
    }),
    {
      lines: [
        ["load_pay", 31_000],
        ["insurance", -900],
      ],
      gross: 31_000,
      deductions: 900,
      net: 30_100,
      insuredDays: 1,
    },
  ],
  [
    "a load with no rate is an exception at 0 cents for a percent driver",
    input({ loads: [load({ id: "a", linehaulCents: null }), percentLoad("b", 100_000)] }),
    {
      lines: [
        ["load_pay", 0],
        ["load_pay", 75_000],
      ],
      gross: 75_000,
      deductions: 0,
      net: 75_000,
      exceptions: ["load_rate_missing"],
    },
  ],
  [
    "a load with no rate is an exception for a flat driver too",
    input({
      driver: driver({ payBasis: "flat", percentBps: null, flatPerLoadCents: c(20_000) }),
      loads: [load({ id: "a", linehaulCents: null })],
    }),
    {
      lines: [["load_pay", 0]],
      gross: 0,
      deductions: 0,
      net: 0,
      exceptions: ["load_rate_missing"],
    },
  ],
  [
    "a load with no rate still pays a per-mile driver from the miles",
    input({ driver: companyDriver(), loads: [load({ id: "a", linehaulCents: null })] }),
    { lines: [["load_pay", 31_000]], gross: 31_000, deductions: 0, net: 31_000 },
  ],
  [
    "Blue Ridge pays loaded miles only",
    input({ driver: companyDriver(), loads: [load({ id: "a", emptyMiles: 120 })] }),
    { lines: [["load_pay", 31_000]], gross: 31_000, deductions: 0, net: 31_000 },
  ],
  [
    "Prairie Wind pays empty miles too",
    input({
      config: PRAIRIE_WIND,
      period: PW_WEEK,
      driver: companyDriver(),
      loads: [load({ id: "a", emptyMiles: 120 })],
    }),
    { lines: [["load_pay", 38_440]], gross: 38_440, deductions: 0, net: 38_440 },
  ],
  [
    "half-paid empty miles round half up per load",
    input({
      config: { ...BLUE_RIDGE, emptyMilesPaidBps: 5_000 },
      driver: companyDriver({ perMileCents: c(61) }),
      loads: [load({ id: "a", loadedMiles: 400, emptyMiles: 75 })],
    }),
    { lines: [["load_pay", 26_688]], gross: 26_688, deductions: 0, net: 26_688 },
  ],
  [
    "a flat-rate driver gets the same amount per load",
    input({
      driver: driver({ payBasis: "flat", percentBps: null, flatPerLoadCents: c(20_000) }),
      loads: [load({ id: "a" }), load({ id: "b", linehaulCents: c(55_000) })],
    }),
    {
      lines: [
        ["load_pay", 20_000],
        ["load_pay", 20_000],
      ],
      gross: 40_000,
      deductions: 0,
      net: 40_000,
    },
  ],
  [
    "two loads of 1 cent at 50% pay 1 + 1",
    input({
      driver: driver({ percentBps: 5_000 }),
      loads: [percentLoad("a", 1), percentLoad("b", 1)],
    }),
    {
      lines: [
        ["load_pay", 1],
        ["load_pay", 1],
      ],
      gross: 2,
      deductions: 0,
      net: 2,
    },
  ],
  [
    "75% of 100,001 cents is 75,001",
    input({ loads: [percentLoad("a", 100_001)] }),
    { lines: [["load_pay", 75_001]], gross: 75_001, deductions: 0, net: 75_001 },
  ],
  [
    "28% of 33,333 cents is 9,333",
    input({ driver: driver({ percentBps: 2_800 }), loads: [percentLoad("a", 33_333)] }),
    { lines: [["load_pay", 9_333]], gross: 9_333, deductions: 0, net: 9_333 },
  ],
];

// One load with every kind of extra, for the base and share settings.
const RICH = load({
  id: "rich",
  linehaulCents: c(100_000),
  fuelSurchargeCents: c(12_000),
  accessorials: [
    {
      id: "det",
      kind: "detention",
      seq: 1,
      amountCents: c(5_000),
      paidByDriver: false,
      description: null,
    },
    {
      id: "stop",
      kind: "stop",
      seq: 1,
      amountCents: c(2_500),
      paidByDriver: false,
      description: null,
    },
    {
      id: "lump",
      kind: "lumper",
      seq: 1,
      amountCents: c(17_500),
      paidByDriver: true,
      description: null,
    },
  ],
});

const withConfig = (over: Partial<PayConfig>, d = driver()) =>
  input({ config: { ...BLUE_RIDGE, ...over }, driver: d, loads: [RICH] });

CASES.push(
  [
    "percent of linehaul only, accessorials paid at the full share, never lumper",
    withConfig({ percentBase: "linehaul" }),
    {
      lines: [
        ["load_pay", 75_000],
        ["accessorial_pay", 7_500],
      ],
      gross: 82_500,
      deductions: 0,
      net: 82_500,
    },
  ],
  [
    "percent of linehaul plus fuel surcharge, accessorials at half share",
    withConfig({ percentBase: "linehaul_fsc", accessorialDriverShareBps: 5_000 }),
    {
      lines: [
        ["load_pay", 84_000],
        ["accessorial_pay", 3_750],
      ],
      gross: 87_750,
      deductions: 0,
      net: 87_750,
    },
  ],
  [
    "percent of linehaul, fuel surcharge and accessorials pays accessorials once, inside the base",
    withConfig({ percentBase: "linehaul_fsc_accessorials" }),
    { lines: [["load_pay", 89_625]], gross: 89_625, deductions: 0, net: 89_625 },
  ],
  [
    "a per-mile driver gets the accessorial share whatever the percent base",
    withConfig({ percentBase: "linehaul_fsc_accessorials" }, companyDriver()),
    {
      lines: [
        ["load_pay", 31_000],
        ["accessorial_pay", 7_500],
      ],
      gross: 38_500,
      deductions: 0,
      net: 38_500,
    },
  ],
  [
    "a zero accessorial share adds no line",
    withConfig({ accessorialDriverShareBps: 0 }),
    { lines: [["load_pay", 75_000]], gross: 75_000, deductions: 0, net: 75_000 },
  ],
);

function check(result: SettlementResult, want: Expected) {
  expect(result.lines.map((l) => [l.kind, l.amountCents])).toEqual(want.lines);
  expect(result.lines.map((l) => l.seq)).toEqual(want.lines.map((_, i) => i + 1));
  expect(result.grossCents).toBe(want.gross);
  expect(result.deductionsCents).toBe(want.deductions);
  expect(result.netCents).toBe(want.net);
  expect(result.carryForwardCents).toBe(want.carry ?? 0);
  expect(result.exceptions.map((e) => e.category)).toEqual(want.exceptions ?? []);
  expect(result.notes.map((n) => [n.kind, n.category, n.amountCents])).toEqual(want.notes ?? []);
  expect(result.recoveries.map((r) => [r.advanceId, r.cents])).toEqual(want.recoveries ?? []);
  expect(result.escrowDeltaCents).toBe(want.escrowDelta ?? 0);
  if (want.insuredDays !== undefined) expect(result.insuredDays).toBe(want.insuredDays);
}

describe("settleDriver: the pay math, case by case", () => {
  it.each(CASES)("%s", (_name, given, want) => {
    check(settleDriver(given), want);
  });

  it.each([...CASES.map(([name, given]) => [name, given] as const), ["the hero", HERO] as const])(
    "every line cites a record and the lines add up to the net: %s",
    (_name, given) => {
      const r = settleDriver(given);
      for (const line of r.lines) expect(line.sources.length).toBeGreaterThan(0);
      for (const e of r.exceptions) expect(e.sources.length).toBeGreaterThan(0);
      for (const n of r.notes) expect(n.sources.length).toBeGreaterThan(0);
      const lineSum = r.lines.reduce((s, l) => s + l.amountCents, 0);
      expect(lineSum + r.carryForwardCents).toBe(r.netCents);
      expect(r.grossCents - r.deductionsCents + r.carryForwardCents).toBe(r.netCents);
      expect(r.netCents).toBeGreaterThanOrEqual(0);
    },
  );
});

describe("settleDriver: weeks that cross the clock change", () => {
  it("puts loads delivered either side of Blue Ridge's Sunday midnight in the right week", () => {
    // 23:30 on Sunday Nov 1 in New York (after fall back) and 00:30 on Monday Nov 2.
    const sunday = localDateOf("2026-11-02T04:30:00Z", "America/New_York");
    const monday = localDateOf("2026-11-02T05:30:00Z", "America/New_York");
    expect([sunday, monday]).toEqual(["2026-11-01", "2026-11-02"]);
    const loads = [
      percentLoad("sun", 100_000, { pickupOn: "2026-10-31", deliveredOn: sunday }),
      percentLoad("mon", 80_000, { pickupOn: "2026-11-01", deliveredOn: monday }),
    ];
    const thisWeek = settleDriver(input({ loads }));
    const nextWeek = settleDriver(
      input({ loads, period: { start: "2026-11-02", end: "2026-11-08" } }),
    );
    expect(thisWeek.lines.map((l) => l.sources[0].id)).toEqual(["sun"]);
    expect(nextWeek.lines.map((l) => l.sources[0].id)).toEqual(["mon"]);
  });

  it("puts loads delivered either side of Prairie Wind's Saturday midnight in their weeks", () => {
    // 23:30 on Saturday Oct 31 in Chicago (still daylight time) and 01:30 on Sunday Nov 1.
    const saturday = localDateOf("2026-11-01T04:30:00Z", "America/Chicago");
    const sunday = localDateOf("2026-11-01T06:30:00Z", "America/Chicago");
    expect([saturday, sunday]).toEqual(["2026-10-31", "2026-11-01"]);
    const loads = [
      percentLoad("sat", 100_000, { deliveredOn: saturday }),
      percentLoad("sun", 80_000, { pickupOn: "2026-10-31", deliveredOn: sunday }),
    ];
    const base = { config: PRAIRIE_WIND, loads };
    const thisWeek = settleDriver(input({ ...base, period: PW_WEEK }));
    const nextWeek = settleDriver(
      input({ ...base, period: { start: "2026-11-01", end: "2026-11-07" } }),
    );
    expect(thisWeek.lines.map((l) => l.sources[0].id)).toEqual(["sat"]);
    expect(nextWeek.lines.map((l) => l.sources[0].id)).toEqual(["sun"]);
  });

  it("charges seven days of insurance in a week with a 25-hour Sunday", () => {
    const days = [
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ];
    const r = settleDriver(input({ days: days.map((d, i) => day(`d${i}`, d)) }));
    expect(r.insuredDays).toBe(7);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].amountCents).toBe(-7_700);
  });
});

describe("settleDriver: fails closed", () => {
  it.each([
    ["a missing config", input({ config: undefined as unknown as PayConfig }), ConfigError],
    [
      "a config out of range",
      input({ config: { ...BLUE_RIDGE, netPayFloorCents: c(-1) } }),
      ConfigError,
    ],
    [
      "a percent driver with no percent",
      input({ driver: driver({ percentBps: null }) }),
      ConfigError,
    ],
    [
      "a reversed period",
      input({ period: { start: "2026-11-01", end: "2026-10-26" } }),
      InputError,
    ],
    [
      "a period in another spelling",
      input({ period: { start: "10/26/2026", end: "2026-11-01" } }),
      InputError,
    ],
    [
      "an unknown load status",
      input({ loads: [load({ id: "a", status: "lost" as never })] }),
      InputError,
    ],
    ["another driver's load", input({ loads: [load({ id: "a", driverId: "drv-2" })] }), InputError],
    [
      "a delivered load without a delivery date",
      input({ loads: [load({ id: "a", deliveredOn: null })] }),
      InputError,
    ],
    [
      "state miles that do not add up",
      input({
        loads: [load({ id: "a", stateMiles: [{ id: "sm", state: "VA", miles: 499 }] })],
      }),
      InputError,
    ],
    [
      "a state that is not a postal code",
      input({
        loads: [load({ id: "a", stateMiles: [{ id: "sm", state: "Va", miles: 500 }] })],
      }),
      InputError,
    ],
    [
      "an unknown accessorial kind",
      input({
        loads: [
          load({
            id: "a",
            accessorials: [
              {
                id: "x",
                kind: "tarp" as never,
                seq: 1,
                amountCents: c(100),
                paidByDriver: false,
                description: null,
              },
            ],
          }),
        ],
      }),
      InputError,
    ],
    [
      "a float amount",
      input({ loads: [load({ id: "a", linehaulCents: 1000.5 as never })] }),
      InputError,
    ],
    [
      "an unknown pay item kind",
      input({ items: [item({ id: "i", kind: "bonus" as never })] }),
      InputError,
    ],
    ["a zero pay item", input({ items: [item({ id: "i", amountCents: c(0) })] }), InputError],
    [
      "an unknown schedule kind",
      input({ schedules: [schedule({ id: "s", kind: "loan" as never })] }),
      InputError,
    ],
    [
      "two leases active at once",
      input({
        loads: [percentLoad("a", 200_000)],
        schedules: [
          schedule({ id: "l1", kind: "lease" }),
          schedule({ id: "l2", kind: "lease", activeFrom: "2026-10-28" }),
        ],
      }),
      InputError,
    ],
    [
      "an unknown day source",
      input({ days: [day("d", "2026-10-28", { source: "guess" as never })] }),
      InputError,
    ],
    [
      "an unknown advance status",
      input({ advances: [advance({ id: "a", status: "lent" as never })] }),
      InputError,
    ],
    [
      "an advance recovered past what it lent",
      input({ advances: [advance({ id: "a", recoveredCents: c(20_001) })] }),
      InputError,
    ],
    [
      "an advance time without a zone",
      input({ advances: [advance({ id: "a", requestedAt: "2026-10-28T15:00:00" })] }),
      InputError,
    ],
    ["a negative escrow balance", input({ escrowBalanceCents: c(-1) }), InputError],
  ])("refuses %s", (_name, given, error) => {
    expect(() => settleDriver(given)).toThrow(error);
  });
});
