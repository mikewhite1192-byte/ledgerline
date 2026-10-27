import {
  compareText,
  sum,
  type DriverRecord,
  type SettlementPeriodRecord,
  type SettlementRecord,
} from "../rules-engine";
import { argsOf, byId, driverCell, labelOf, mustGet, reportOf, SETTLEMENT_WORDS, WORKER_WORDS } from "./build";
import type { ReportResult, ReportRow, ReportSubtotal } from "./types";

// What the next pay run will pay out: the stored settlements of one week that are not paid yet
// (draft or approved) with net pay above zero, by worker type, with the total. The week is the
// one asked for, or the open week.

export type CashNeededInput = {
  periods: readonly SettlementPeriodRecord[];
  settlements: readonly SettlementRecord[];
  drivers: readonly DriverRecord[];
};

export type CashNeededArgs = { periodStart?: string };

const GROUPS: readonly { type: DriverRecord["workerType"]; label: string }[] = [
  { type: "company", label: "Company drivers" },
  { type: "owner_operator", label: "Owner-operators" },
];

function weekOf(input: CashNeededInput, periodStart?: string): SettlementPeriodRecord | null {
  if (periodStart !== undefined) return input.periods.find((p) => p.periodStart === periodStart) ?? null;
  const open = input.periods.filter((p) => p.status === "open");
  open.sort((a, b) => compareText(b.periodStart, a.periodStart));
  return open[0] ?? null;
}

export function computeCashNeeded(input: CashNeededInput, args: CashNeededArgs, asOf: string): ReportResult {
  const week = weekOf(input, args.periodStart);
  if (!week) {
    return reportOf("cash_needed", {
      asOf,
      args: argsOf({ periodStart: args.periodStart }),
      rows: [],
      emptyReason: "no_pay_run",
    });
  }
  const drivers = byId(input.drivers, "drivers");
  const inWeek = input.settlements.filter((s) => s.periodId === week.id);
  const due = inWeek.filter((s) => (s.status === "draft" || s.status === "approved") && s.netCents > 0);
  const rows: { type: DriverRecord["workerType"]; row: ReportRow; net: number }[] = due.map((s) => {
    const driver = mustGet(drivers, s.driverId, "driver");
    return {
      type: driver.workerType,
      net: s.netCents,
      row: {
        driver: driverCell(driver),
        workerType: WORKER_WORDS[driver.workerType],
        status: SETTLEMENT_WORDS[s.status],
        netDueCents: s.netCents,
      },
    };
  });
  const order = (t: DriverRecord["workerType"]) => GROUPS.findIndex((g) => g.type === t);
  rows.sort((a, b) => order(a.type) - order(b.type) || compareText(labelOf(a.row.driver), labelOf(b.row.driver)));
  const subtotals: ReportSubtotal[] = GROUPS.filter((g) => rows.some((r) => r.type === g.type)).map((g) => ({
    label: g.label,
    totals: { netDueCents: sum(rows.filter((r) => r.type === g.type).map((r) => r.net)) },
  }));
  return reportOf("cash_needed", {
    asOf,
    args: { periodStart: week.periodStart },
    period: { start: week.periodStart, end: week.periodEnd },
    rows: rows.map((r) => r.row),
    totals: { netDueCents: sum(rows.map((r) => r.net)) },
    subtotals,
    // No settlements at all means the run was not built; built and all paid means nothing is due.
    emptyReason: inWeek.length === 0 ? "no_pay_run" : "no_rows",
  });
}
