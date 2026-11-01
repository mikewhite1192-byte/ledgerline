import { describe, expect, it } from "vitest";
import type { SettlementPeriodRecord, SettlementRecord } from "../rules-engine";
import { settleDriver } from "../rules-engine/settlement";
import { advance, BLUE_RIDGE, c, companyDriver, driver, item, load } from "../rules-engine/test-records";
import { parseReportArgs, ReportArgsError } from "./args";
import {
  assertInsightWindow,
  computeDriverInsights,
  driverInsightsOf,
  insightWindow,
  type DriverInsightsInput,
} from "./driver-insights";

// The driver insights over fixed records and a fixed as-of date: no clock, no database.

const AS_OF = "2026-11-02";
const WINDOW = { start: "2026-10-06", end: "2026-11-02" };

const A = driver({ id: "d-a", code: "T-D01", firstName: "Avery", lastName: "Quill" });
const B = companyDriver({ id: "d-b", code: "T-D02", firstName: "Blair", lastName: "Stone", moneyArmed: false });
const C = driver({ id: "d-c", code: "T-D03", firstName: "Casey", lastName: "Reed", activeTo: "2026-09-30" });
const D = driver({ id: "d-d", code: "T-D04", firstName: "Dana", lastName: "Holt" });

const period = (id: string, end: string): SettlementPeriodRecord => ({
  id,
  periodStart: "2026-01-01",
  periodEnd: end,
  status: "paid",
});

const stub = (over: Partial<SettlementRecord> & { id: string; periodId: string; driverId: string }): SettlementRecord => ({
  status: "paid",
  grossCents: c(100_000),
  deductionsCents: c(20_000),
  netCents: c(80_000),
  carryForwardCents: c(0),
  exceptionCount: 0,
  paidAt: "2026-10-10T15:00:00Z",
  ...over,
});

const empty = (over: Partial<DriverInsightsInput> = {}): DriverInsightsInput => ({
  drivers: [A, B, C, D],
  periods: [],
  settlements: [],
  lines: [],
  loads: [],
  advances: [],
  deficits: [],
  ...over,
});

describe("insightWindow", () => {
  it("defaults to the 28 days ending on the as-of date", () => {
    expect(insightWindow({}, AS_OF)).toEqual(WINDOW);
  });

  it("ends a window given only its end 28 days back, and keeps one given whole", () => {
    expect(insightWindow({ to: "2026-10-31" }, AS_OF)).toEqual({ start: "2026-10-04", end: "2026-10-31" });
    expect(insightWindow({ from: "2026-10-01", to: "2026-10-01" }, AS_OF)).toEqual({ start: "2026-10-01", end: "2026-10-01" });
  });

  it("refuses a window that runs backward or covers more than 366 days", () => {
    expect(() => insightWindow({ from: "2026-11-03" }, AS_OF)).toThrow(RangeError);
    expect(() => assertInsightWindow({ start: "2026-11-02", end: "2026-11-01" })).toThrow(RangeError);
    expect(assertInsightWindow({ start: "2025-11-02", end: "2026-11-02" })).toEqual({ start: "2025-11-02", end: "2026-11-02" });
    expect(() => assertInsightWindow({ start: "2025-11-01", end: "2026-11-02" })).toThrow(RangeError);
    expect(() => assertInsightWindow({ start: "2026-02-30", end: "2026-03-02" })).toThrow();
  });

  it("refuses a lone from after today or 366 days or more back as the args' fault, and takes a lone to anywhere", () => {
    for (const from of ["2026-11-03", "2025-11-01"]) {
      let thrown: unknown = null;
      try {
        insightWindow({ from }, AS_OF);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, from).toBeInstanceOf(ReportArgsError);
      expect((thrown as ReportArgsError).path).toBe("from");
    }
    expect(insightWindow({ from: AS_OF }, AS_OF)).toEqual({ start: AS_OF, end: AS_OF });
    expect(insightWindow({ from: "2025-11-02" }, AS_OF)).toEqual({ start: "2025-11-02", end: AS_OF });
    expect(insightWindow({ to: "2027-01-31" }, AS_OF)).toEqual({ start: "2027-01-04", end: "2027-01-31" });
    expect(insightWindow({ to: "2024-01-31" }, AS_OF)).toEqual({ start: "2024-01-04", end: "2024-01-31" });
  });

  it("parses the same rule from the args: forward, at most 366 days, either end optional", () => {
    expect(parseReportArgs("driver_insights", {})).not.toBeNull();
    expect(parseReportArgs("driver_insights", { from: "2026-10-01" })).not.toBeNull();
    expect(parseReportArgs("driver_insights", { from: "2025-11-02", to: "2026-11-02" })).not.toBeNull();
    expect(parseReportArgs("driver_insights", { from: "2025-11-01", to: "2026-11-02" })).toBeNull();
    expect(parseReportArgs("driver_insights", { from: "2026-11-02", to: "2026-11-01" })).toBeNull();
    expect(parseReportArgs("driver_insights", { from: "2026-13-01" })).toBeNull();
    expect(parseReportArgs("driver_insights", { asOf: AS_OF })).toBeNull();
  });
});

describe("driverInsightsOf", () => {
  it("counts the pay weeks that end on either edge of the window and not a day outside it", () => {
    const input = empty({
      periods: [period("p-before", "2026-10-05"), period("p-first", "2026-10-06"), period("p-last", "2026-11-02"), period("p-after", "2026-11-03")],
      settlements: [
        stub({ id: "s1", periodId: "p-before", driverId: A.id }),
        stub({ id: "s2", periodId: "p-first", driverId: A.id }),
        stub({ id: "s3", periodId: "p-last", driverId: A.id, grossCents: c(50_000), deductionsCents: c(5_000), netCents: c(45_000) }),
        stub({ id: "s4", periodId: "p-after", driverId: A.id }),
      ],
    });
    const a = driverInsightsOf(input, WINDOW, AS_OF).rows.find((r) => r.driver.id === A.id)!;
    expect(a).toMatchObject({ grossCents: 150_000, deductionsCents: 25_000, netCents: 125_000 });
  });

  it("reads paid paystubs only, and the fuel lines of those alone", () => {
    const input = empty({
      periods: [period("p1", "2026-10-20")],
      settlements: [
        stub({ id: "s-paid", periodId: "p1", driverId: A.id }),
        stub({ id: "s-approved", periodId: "p1", driverId: B.id, status: "approved" }),
        stub({ id: "s-draft", periodId: "p1", driverId: D.id, status: "draft" }),
      ],
      lines: [
        { settlementId: "s-paid", kind: "fuel", amountCents: -12_345 },
        { settlementId: "s-paid", kind: "fuel", amountCents: -655 },
        { settlementId: "s-paid", kind: "other_deduction", amountCents: -9_999 },
        { settlementId: "s-approved", kind: "fuel", amountCents: -7_000 },
      ],
    });
    const rows = driverInsightsOf(input, WINDOW, AS_OF).rows;
    expect(rows.find((r) => r.driver.id === A.id)).toMatchObject({ netCents: 80_000, fuelCents: 13_000 });
    expect(rows.find((r) => r.driver.id === B.id)).toMatchObject({ netCents: 0, grossCents: 0, fuelCents: 0 });
    expect(rows.find((r) => r.driver.id === D.id)).toMatchObject({ netCents: 0 });
  });

  it("refuses a positive fuel line on a paid stub: the engine writes deductions negative", () => {
    const input = empty({
      periods: [period("p1", "2026-10-20")],
      settlements: [stub({ id: "s-paid", periodId: "p1", driverId: A.id })],
      lines: [{ settlementId: "s-paid", kind: "fuel", amountCents: 500 }],
    });
    expect(() => driverInsightsOf(input, WINDOW, AS_OF)).toThrow(RangeError);
  });

  it("reads fuel deducted as a positive figure and names its leader over stubs the engine settled", () => {
    const week = { start: "2026-10-26", end: "2026-11-01" };
    const settled = [
      { driver: A, fuel: 28_640, stubId: "s-eng-a" },
      { driver: D, fuel: 10_000, stubId: "s-eng-d" },
    ].map(({ driver: d, fuel, stubId }) => {
      const result = settleDriver({
        config: BLUE_RIDGE,
        driver: d,
        period: week,
        loads: [load({ id: `l-${d.id}`, driverId: d.id, linehaulCents: c(200_000) })],
        days: [],
        items: [item({ id: `fuel-${d.id}`, driverId: d.id, kind: "fuel", amountCents: c(fuel) })],
        schedules: [],
        advances: [],
        escrowBalanceCents: c(0),
      });
      const record = stub({
        id: stubId,
        periodId: "p-eng",
        driverId: d.id,
        grossCents: result.grossCents,
        deductionsCents: result.deductionsCents,
        netCents: result.netCents,
        carryForwardCents: result.carryForwardCents,
      });
      return { record, lines: result.lines.map((l) => ({ settlementId: stubId, kind: l.kind, amountCents: l.amountCents })) };
    });
    // The engine wrote the fuel line negative; the report reads it back as fuel deducted.
    expect(settled[0].lines.filter((l) => l.kind === "fuel").map((l) => l.amountCents)).toEqual([-28_640]);
    const input = empty({
      periods: [period("p-eng", week.end)],
      settlements: settled.map((s) => s.record),
      lines: settled.flatMap((s) => s.lines),
    });
    const { rows, leaders } = driverInsightsOf(input, WINDOW, AS_OF);
    const a = rows.find((r) => r.driver.id === A.id)!;
    expect(a.fuelCents).toBe(28_640);
    expect(a.deductionsCents).toBe(settled[0].record.deductionsCents);
    expect(a.deductionsCents).toBeGreaterThanOrEqual(28_640);
    expect(rows.find((r) => r.driver.id === D.id)?.fuelCents).toBe(10_000);
    expect(leaders.mostFuel).toEqual({ driver: expect.objectContaining({ id: A.id }), valueCents: 28_640 });
  });

  it("counts loads and miles by delivered date inside the window", () => {
    const input = empty({
      loads: [
        { driverId: B.id, deliveredOn: "2026-10-05", loadedMiles: 999, emptyMiles: 9 },
        { driverId: B.id, deliveredOn: "2026-10-06", loadedMiles: 400, emptyMiles: 20 },
        { driverId: B.id, deliveredOn: "2026-11-02", loadedMiles: 600, emptyMiles: 30 },
        { driverId: B.id, deliveredOn: "2026-11-03", loadedMiles: 999, emptyMiles: 9 },
      ],
    });
    const b = driverInsightsOf(input, WINDOW, AS_OF).rows.find((r) => r.driver.id === B.id)!;
    expect(b).toMatchObject({ loads: 2, loadedMiles: 1_000, emptyMiles: 50 });
  });

  it("counts the advances taken in the window and what every approved or paid one still owes", () => {
    const input = empty({
      advances: [
        advance({ id: "a-old", driverId: A.id, requestedOn: "2026-09-01", amountCents: c(30_000), recoveredCents: c(10_000) }),
        advance({ id: "a-in", driverId: A.id, requestedOn: "2026-10-06", amountCents: c(20_000), feeCents: c(500) }),
        advance({ id: "a-approved", driverId: A.id, requestedOn: "2026-11-02", amountCents: c(5_000), status: "approved" }),
        advance({ id: "a-rejected", driverId: A.id, requestedOn: "2026-10-20", amountCents: c(9_000), status: "rejected" }),
        advance({ id: "a-recovered", driverId: D.id, requestedOn: "2026-09-01", amountCents: c(9_000), recoveredCents: c(9_000) }),
      ],
      deficits: [
        { driverId: A.id, owedCents: 4_000 },
        { driverId: B.id, owedCents: 0 },
      ],
    });
    const rows = driverInsightsOf(input, WINDOW, AS_OF).rows;
    expect(rows.find((r) => r.driver.id === A.id)).toMatchObject({
      advancesTaken: 2,
      advancesTakenCents: 25_000,
      advancesOwedCents: 20_000 + 20_500 + 5_000,
      deficitsOwedCents: 4_000,
      owedCents: 49_500,
    });
    expect(rows.find((r) => r.driver.id === D.id)).toMatchObject({ advancesTaken: 0, owedCents: 0 });
    expect(rows.find((r) => r.driver.id === B.id)).toMatchObject({ deficitsOwedCents: 0, owedCents: 0 });
  });

  it("shows every active driver, a departed one only with something in the window or owed", () => {
    const quiet = driverInsightsOf(empty(), WINDOW, AS_OF);
    expect(quiet.rows.map((r) => r.driver.code)).toEqual(["T-D01", "T-D02", "T-D04"]);
    expect(quiet.rows.every((r) => r.netCents === 0 && r.owedCents === 0)).toBe(true);
    const every = driverInsightsOf(empty(), WINDOW, AS_OF, { everyDriver: true });
    expect(every.rows.map((r) => [r.driver.code, r.departed])).toEqual([
      ["T-D01", false],
      ["T-D02", false],
      ["T-D03", true],
      ["T-D04", false],
    ]);
    const owing = driverInsightsOf(empty({ deficits: [{ driverId: C.id, owedCents: 100 }] }), WINDOW, AS_OF);
    expect(owing.rows.find((r) => r.driver.id === C.id)).toMatchObject({ departed: true, owedCents: 100 });
  });

  it("keeps a driver whose last day is today or later active", () => {
    const leaving = driver({ id: "d-e", code: "T-D05", activeTo: AS_OF });
    const rows = driverInsightsOf(empty({ drivers: [leaving] }), WINDOW, AS_OF).rows;
    expect(rows).toEqual([expect.objectContaining({ departed: false })]);
  });

  it("refuses a row that names a driver not on file", () => {
    const input = empty({ loads: [{ driverId: "d-missing", deliveredOn: "2026-10-10", loadedMiles: 1, emptyMiles: 0 }] });
    expect(() => driverInsightsOf(input, WINDOW, AS_OF)).toThrow(/not on file/);
  });

  it("names each figure's leader by its largest value, ties to the lower code, and null when all are zero", () => {
    const input = empty({
      periods: [period("p1", "2026-10-20")],
      settlements: [
        stub({ id: "s-d", periodId: "p1", driverId: D.id, grossCents: c(90_000), deductionsCents: c(0), netCents: c(90_000) }),
        stub({ id: "s-a", periodId: "p1", driverId: A.id, grossCents: c(120_000), deductionsCents: c(30_000), netCents: c(90_000) }),
      ],
      loads: [
        { driverId: D.id, deliveredOn: "2026-10-10", loadedMiles: 500, emptyMiles: 100 },
        { driverId: B.id, deliveredOn: "2026-10-11", loadedMiles: 550, emptyMiles: 50 },
        { driverId: B.id, deliveredOn: "2026-10-12", loadedMiles: 0, emptyMiles: 0 },
      ],
    });
    const { leaders, rows } = driverInsightsOf(input, WINDOW, AS_OF);
    // A and D tie on net: the lower code wins.
    expect(leaders.topNet).toEqual({ driver: expect.objectContaining({ id: A.id }), valueCents: 90_000 });
    expect(leaders.topGross).toEqual({ driver: expect.objectContaining({ id: A.id }), valueCents: 120_000 });
    expect(leaders.mostLoads).toEqual({ driver: expect.objectContaining({ id: B.id }), value: 2 });
    // B and D tie on loaded plus empty miles (600): the lower code wins.
    expect(leaders.mostMiles).toEqual({ driver: expect.objectContaining({ id: B.id, label: "Blair Stone (T-D02)" }), value: 600 });
    expect(leaders.mostAdvances).toBeNull();
    expect(leaders.mostOwed).toBeNull();
    expect(leaders.mostFuel).toBeNull();
    // Net largest first, ties by code.
    expect(rows.map((r) => r.driver.code)).toEqual(["T-D01", "T-D04", "T-D02"]);
  });

  it("names no leader at all over an empty window", () => {
    const { leaders } = driverInsightsOf(empty(), WINDOW, AS_OF);
    expect(Object.values(leaders)).toEqual([null, null, null, null, null, null, null]);
  });
});

describe("computeDriverInsights", () => {
  it("returns the report: one row per driver, the window as its args and period, totals and leaders", () => {
    const input = empty({
      periods: [period("p1", "2026-10-20")],
      settlements: [stub({ id: "s1", periodId: "p1", driverId: B.id })],
      lines: [{ settlementId: "s1", kind: "fuel", amountCents: -6_000 }],
      loads: [{ driverId: B.id, deliveredOn: "2026-10-15", loadedMiles: 300, emptyMiles: 12 }],
      advances: [advance({ id: "a1", driverId: A.id, requestedOn: "2026-10-30", amountCents: c(15_000) })],
    });
    const r = computeDriverInsights(input, {}, AS_OF);
    expect(r).toMatchObject({ report: "driver_insights", title: "Driver insights", asOf: AS_OF, args: { from: WINDOW.start, to: WINDOW.end } });
    expect(r.period).toEqual(WINDOW);
    expect(r.rows.map((row) => (row.driver as { label: string }).label)).toEqual([
      "Blair Stone (T-D02)",
      "Avery Quill (T-D01)",
      "Dana Holt (T-D04)",
    ]);
    expect(r.rows[0]).toMatchObject({
      workerType: "Company driver",
      status: "Active",
      armed: "No",
      netCents: 80_000,
      fuelCents: 6_000,
      loads: 1,
      loadedMiles: 300,
      emptyMiles: 12,
    });
    expect(r.totals).toMatchObject({ netCents: 80_000, grossCents: 100_000, loads: 1, advancesTaken: 1, owedCents: 15_000 });
    expect(r.leaders?.mostOwed).toEqual({ driver: expect.objectContaining({ id: A.id }), valueCents: 15_000 });
    expect(r.notes?.length).toBe(1);
    expect(r.columns.map((col) => col.key)).toContain("owedCents");
  });

  it("says there are no rows when the carrier has no drivers", () => {
    const r = computeDriverInsights(empty({ drivers: [] }), { from: "2026-10-01", to: "2026-10-31" }, AS_OF);
    expect(r.rows).toEqual([]);
    expect(r.emptyReason).toBe("no_rows");
    expect(r.totals).toBeUndefined();
    expect(r.period).toEqual({ start: "2026-10-01", end: "2026-10-31" });
  });
});
