import {
  compareText,
  sum,
  type DriverRecord,
  type SettlementPeriodRecord,
  type SettlementRecord,
} from "../rules-engine";
import {
  argsOf,
  byId,
  driverCell,
  labelOf,
  mustGet,
  periodHolding,
  reportOf,
  SETTLEMENT_WORDS,
  WORKER_WORDS,
} from "./build";
import type { ReportResult, ReportRow } from "./types";

// Each driver's pay for one week, from the settlements the pay run stored (the engine's own
// totals, saved when the run was built). Recomputing every driver here would not fit a tool's
// time limit, and the stored rows are the numbers on the paystubs.

export type DriverPaySummaryInput = {
  periods: readonly SettlementPeriodRecord[];
  settlements: readonly SettlementRecord[];
  drivers: readonly DriverRecord[];
};

export type DriverPaySummaryArgs = { periodStart?: string; driverId?: string };

// The week that holds the day asked for (its first day or any day in it), or the latest week the
// pay run has settlements for. The result's args name the first day of the week used.
function weekOf(input: DriverPaySummaryInput, day?: string): SettlementPeriodRecord | null {
  if (day !== undefined) return periodHolding(input.periods, day);
  const settled = new Set(input.settlements.map((s) => s.periodId));
  const withRows = input.periods.filter((p) => settled.has(p.id));
  withRows.sort((a, b) => compareText(b.periodStart, a.periodStart));
  return withRows[0] ?? null;
}

export function computeDriverPaySummary(
  input: DriverPaySummaryInput,
  args: DriverPaySummaryArgs,
  asOf: string,
): ReportResult {
  const week = weekOf(input, args.periodStart);
  if (!week) {
    return reportOf("driver_pay_summary", {
      asOf,
      args: argsOf({ periodStart: args.periodStart, driverId: args.driverId }),
      rows: [],
      emptyReason: "no_pay_run",
    });
  }
  const drivers = byId(input.drivers, "drivers");
  const inWeek = input.settlements.filter((s) => s.periodId === week.id);
  const picked = inWeek.filter((s) => !args.driverId || s.driverId === args.driverId);
  const rows: ReportRow[] = picked.map((s) => {
    const driver = mustGet(drivers, s.driverId, "driver");
    return {
      driver: driverCell(driver),
      workerType: WORKER_WORDS[driver.workerType],
      status: SETTLEMENT_WORDS[s.status],
      grossCents: s.grossCents,
      deductionsCents: s.deductionsCents,
      netCents: s.netCents,
      carryForwardCents: s.carryForwardCents,
      exceptions: s.exceptionCount,
    };
  });
  rows.sort((a, b) => compareText(labelOf(a.driver), labelOf(b.driver)));
  return reportOf("driver_pay_summary", {
    asOf,
    args: argsOf({ periodStart: week.periodStart, driverId: args.driverId }),
    period: { start: week.periodStart, end: week.periodEnd },
    rows,
    totals: {
      grossCents: sum(picked.map((s) => s.grossCents)),
      deductionsCents: sum(picked.map((s) => s.deductionsCents)),
      netCents: sum(picked.map((s) => s.netCents)),
      carryForwardCents: sum(picked.map((s) => s.carryForwardCents)),
      exceptions: sum(picked.map((s) => s.exceptionCount)),
    },
    emptyReason: inWeek.length === 0 ? "no_pay_run" : "no_rows",
  });
}
