import {
  compareText,
  outstandingCents,
  sum,
  type AdvanceRecord,
  type DriverRecord,
  type SettlementPeriodRecord,
  type SettlementRecord,
} from "../rules-engine";
import { addDays, assertLocalDate, daysBetween, type LocalDate, type Period } from "../time/local-date";
import { MAX_INSIGHT_DAYS } from "./args";
import { byId, driverCell, mustGet, reportOf, WORKER_WORDS } from "./build";
import type { CentsLeader, CountLeader, DriverLeaders, ReportResult, ReportRow } from "./types";

// The driver insights (design-d1-drivers 4.2): per driver over a window of the carrier's own
// dates, the pay on the paid paystubs of the pay weeks that end in it (the engine's stored totals,
// as the driver pay summary reads them), the fuel deducted on those stubs, the loads delivered and
// their miles, the advances taken; and, as of today, what each driver still owes (advances and
// deficits). Pure, integer cents, and the leaders of each figure with ties to the lower code, so
// the same rows always name the same driver.

export const INSIGHT_DEFAULT_DAYS = 28;

export type InsightLine = { settlementId: string; kind: string; amountCents: number };
export type InsightLoad = { driverId: string; deliveredOn: LocalDate; loadedMiles: number; emptyMiles: number };
// What one driver owes on deficits not settled yet: amount less recovered, summed.
export type InsightDeficit = { driverId: string; owedCents: number };

export type DriverInsightsInput = {
  drivers: readonly DriverRecord[];
  periods: readonly SettlementPeriodRecord[];
  settlements: readonly SettlementRecord[];
  lines: readonly InsightLine[];
  loads: readonly InsightLoad[];
  advances: readonly AdvanceRecord[];
  deficits: readonly InsightDeficit[];
};

export type DriverInsight = {
  driver: DriverRecord;
  departed: boolean;
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  fuelCents: number;
  loads: number;
  loadedMiles: number;
  emptyMiles: number;
  advancesTaken: number;
  advancesTakenCents: number;
  advancesOwedCents: number;
  deficitsOwedCents: number;
  owedCents: number;
};

export type DriverInsights = { window: Period; rows: DriverInsight[]; leaders: DriverLeaders };

// The window must run forward and cover at most 366 days; anything else is refused before a read.
export function assertInsightWindow(window: Period): Period {
  const start = assertLocalDate(window.start, "window start");
  const end = assertLocalDate(window.end, "window end");
  const days = daysBetween(start, end);
  if (days < 0) throw new RangeError("the window ends before it starts");
  if (days >= MAX_INSIGHT_DAYS) throw new RangeError("the window covers more than 366 days");
  return { start, end };
}

// The window the args name: `to` default asOf, `from` default the 28 days ending on `to`.
export function insightWindow(args: { from?: LocalDate; to?: LocalDate }, asOf: LocalDate): Period {
  const end = args.to ?? asOf;
  const start = args.from ?? addDays(assertLocalDate(end, "window end"), -(INSIGHT_DEFAULT_DAYS - 1));
  return assertInsightWindow({ start, end });
}

const within = (date: LocalDate, w: Period) => w.start <= date && date <= w.end;

type Totals = Omit<DriverInsight, "driver" | "departed">;

const zero = (): Totals => ({
  grossCents: 0,
  deductionsCents: 0,
  netCents: 0,
  fuelCents: 0,
  loads: 0,
  loadedMiles: 0,
  emptyMiles: 0,
  advancesTaken: 0,
  advancesTakenCents: 0,
  advancesOwedCents: 0,
  deficitsOwedCents: 0,
  owedCents: 0,
});

const wholeCount = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} is not a whole count`);
  return n;
};

// everyDriver keeps a departed driver with nothing in the window (the list page shows every driver
// on file); the report leaves those out.
export function driverInsightsOf(
  input: DriverInsightsInput,
  window: Period,
  asOf: LocalDate,
  opts: { everyDriver?: boolean } = {},
): DriverInsights {
  const w = assertInsightWindow(window);
  assertLocalDate(asOf, "as of");
  const drivers = byId(input.drivers, "drivers");
  const acc = new Map<string, Totals>();
  const touch = (driverId: string): Totals => {
    mustGet(drivers, driverId, "driver");
    let t = acc.get(driverId);
    if (!t) {
      t = zero();
      acc.set(driverId, t);
    }
    return t;
  };

  // Paid stubs of the pay weeks that end inside the window, read again here so a wider read
  // never counts.
  const periods = new Set(input.periods.filter((p) => within(p.periodEnd, w)).map((p) => p.id));
  const paid = new Map<string, SettlementRecord>();
  for (const s of input.settlements) {
    if (s.status !== "paid" || !periods.has(s.periodId)) continue;
    paid.set(s.id, s);
    const t = touch(s.driverId);
    t.grossCents = sum([t.grossCents, s.grossCents]);
    t.deductionsCents = sum([t.deductionsCents, s.deductionsCents]);
    t.netCents = sum([t.netCents, s.netCents]);
  }
  // Deduction lines are stored positive.
  for (const l of input.lines) {
    const s = l.kind === "fuel" ? paid.get(l.settlementId) : undefined;
    if (!s) continue;
    const t = touch(s.driverId);
    t.fuelCents = sum([t.fuelCents, l.amountCents]);
  }
  for (const l of input.loads) {
    if (!within(assertLocalDate(l.deliveredOn, "delivered on"), w)) continue;
    const t = touch(l.driverId);
    t.loads += 1;
    t.loadedMiles = wholeCount(t.loadedMiles + wholeCount(l.loadedMiles, "loaded miles"), "loaded miles");
    t.emptyMiles = wholeCount(t.emptyMiles + wholeCount(l.emptyMiles, "empty miles"), "empty miles");
  }
  // Advances: the ones taken in the window, and what every approved or paid one still owes.
  for (const a of input.advances) {
    if (a.status !== "approved" && a.status !== "paid") continue;
    const owed = outstandingCents(a);
    const taken = within(a.requestedOn, w);
    if (!taken && owed <= 0) continue;
    const t = touch(a.driverId);
    if (taken) {
      t.advancesTaken += 1;
      t.advancesTakenCents = sum([t.advancesTakenCents, a.amountCents]);
    }
    t.advancesOwedCents = sum([t.advancesOwedCents, owed]);
  }
  for (const d of input.deficits) {
    if (d.owedCents <= 0) continue;
    const t = touch(d.driverId);
    t.deficitsOwedCents = sum([t.deficitsOwedCents, d.owedCents]);
  }

  const rows: DriverInsight[] = [];
  for (const driver of input.drivers) {
    const departed = driver.activeTo !== null && driver.activeTo < asOf;
    const t = acc.get(driver.id);
    // A driver with nothing in the window and nothing owed shows only while active, with zeros.
    if (!t && departed && opts.everyDriver !== true) continue;
    const totals = t ?? zero();
    rows.push({
      driver,
      departed,
      ...totals,
      owedCents: sum([totals.advancesOwedCents, totals.deficitsOwedCents]),
    });
  }
  rows.sort((a, b) => b.netCents - a.netCents || compareText(a.driver.code, b.driver.code));
  return { window: w, rows, leaders: leadersOf(rows) };
}

// The row with the largest value, ties to the lower code; null when no row has more than zero.
function leaderOf(rows: readonly DriverInsight[], value: (r: DriverInsight) => number): DriverInsight | null {
  let best: DriverInsight | null = null;
  for (const r of rows) {
    const v = value(r);
    if (v <= 0) continue;
    if (best === null || v > value(best) || (v === value(best) && compareText(r.driver.code, best.driver.code) < 0)) {
      best = r;
    }
  }
  return best;
}

function centsLeader(rows: readonly DriverInsight[], value: (r: DriverInsight) => number): CentsLeader | null {
  const r = leaderOf(rows, value);
  return r ? { driver: driverCell(r.driver), valueCents: value(r) } : null;
}

function countLeader(rows: readonly DriverInsight[], value: (r: DriverInsight) => number): CountLeader | null {
  const r = leaderOf(rows, value);
  return r ? { driver: driverCell(r.driver), value: value(r) } : null;
}

export function leadersOf(rows: readonly DriverInsight[]): DriverLeaders {
  return {
    topNet: centsLeader(rows, (r) => r.netCents),
    topGross: centsLeader(rows, (r) => r.grossCents),
    mostLoads: countLeader(rows, (r) => r.loads),
    mostMiles: countLeader(rows, (r) => r.loadedMiles + r.emptyMiles),
    mostAdvances: countLeader(rows, (r) => r.advancesTaken),
    mostOwed: centsLeader(rows, (r) => r.owedCents),
    mostFuel: centsLeader(rows, (r) => r.fuelCents),
  };
}

const TOTAL_KEYS = [
  "netCents",
  "grossCents",
  "deductionsCents",
  "fuelCents",
  "loads",
  "loadedMiles",
  "emptyMiles",
  "advancesTaken",
  "advancesTakenCents",
  "advancesOwedCents",
  "deficitsOwedCents",
  "owedCents",
] as const satisfies readonly (keyof DriverInsight)[];

export const INSIGHT_NOTE =
  "Pay and fuel are from the paid paystubs of the pay weeks that end in the window; loads and miles " +
  "are by delivered date; owed is as of today: advances still outstanding plus deficits not settled.";

export function computeDriverInsights(
  input: DriverInsightsInput,
  args: { from?: LocalDate; to?: LocalDate },
  asOf: LocalDate,
): ReportResult {
  const window = insightWindow(args, asOf);
  const insights = driverInsightsOf(input, window, asOf);
  const rows: ReportRow[] = insights.rows.map((r) => ({
    driver: driverCell(r.driver),
    workerType: WORKER_WORDS[r.driver.workerType],
    status: r.departed ? "Departed" : "Active",
    armed: r.driver.moneyArmed ? "Yes" : "No",
    netCents: r.netCents,
    grossCents: r.grossCents,
    deductionsCents: r.deductionsCents,
    fuelCents: r.fuelCents,
    loads: r.loads,
    loadedMiles: r.loadedMiles,
    emptyMiles: r.emptyMiles,
    advancesTaken: r.advancesTaken,
    advancesTakenCents: r.advancesTakenCents,
    advancesOwedCents: r.advancesOwedCents,
    deficitsOwedCents: r.deficitsOwedCents,
    owedCents: r.owedCents,
  }));
  const totals: Record<string, number> = {};
  for (const k of TOTAL_KEYS) {
    totals[k] = k.endsWith("Cents")
      ? sum(insights.rows.map((r) => r[k]))
      : wholeCount(insights.rows.reduce((n, r) => n + r[k], 0), k);
  }
  const result = reportOf("driver_insights", {
    asOf,
    args: { from: window.start, to: window.end },
    period: { start: window.start, end: window.end },
    rows,
    totals,
    notes: [INSIGHT_NOTE],
  });
  return { ...result, leaders: insights.leaders };
}
