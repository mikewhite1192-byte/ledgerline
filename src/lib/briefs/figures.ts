import type { Queryable } from "../db";
import { readReportInput } from "../data/read";
import { customerOf, driverOf, loadsOf, periodOf, receivablesInputOf } from "../data/records";
import { formatCents } from "../format/money";
import { marginLines, type MarginLine } from "../reports/margin-per-load";
import { payConfigOn } from "../reports/run";
import {
  compareText,
  customerPaying,
  profitFigures,
  profitTotals,
  rollupByCustomer,
  rollupByLane,
  type BriefFigure,
  type CustomerPaying,
  type CustomerRollup,
  type LaneRollup,
  type ProfitFigureLimits,
  type ProfitTotals,
  type ReceivablesInput,
} from "../rules-engine";
import type { LocalDate, Period } from "../time/local-date";

// What the profit brief reads and shows for one closed pay week: every load delivered in it,
// priced by the same code as the margin report, rolled up by route and by customer, with how
// fast each customer pays. Reads only (SELECT, inside the caller's tenant transaction); the
// numbers come from the rules engine, never from a model.

// The picker offers this many closed weeks, newest first.
export const PROFIT_WEEKS = 4;

export type ClosedWeek = { id: string; start: LocalDate; end: LocalDate };

// The pay weeks a brief can be written for: approved or paid, ended before today (the carrier's
// own date), newest first, at most PROFIT_WEEKS. An open week is still changing, so it has none.
export async function closedWeeks(q: Queryable, today: LocalDate): Promise<ClosedWeek[]> {
  const rows = await readReportInput(q, ["settlement_periods"]);
  return rows.settlement_periods
    .map(periodOf)
    .filter((p) => (p.status === "approved" || p.status === "paid") && p.periodEnd < today)
    .sort((a, b) => compareText(b.periodStart, a.periodStart) || compareText(b.id, a.id))
    .slice(0, PROFIT_WEEKS)
    .map((p) => ({ id: p.id, start: p.periodStart, end: p.periodEnd }));
}

export async function lastClosedWeek(q: Queryable, today: LocalDate): Promise<ClosedWeek | null> {
  return (await closedWeeks(q, today))[0] ?? null;
}

export type ProfitInput = { lines: MarginLine[]; receivables: ReceivablesInput };

// Every load delivered in the week, priced, and the carrier's receivables. Customers' paying is
// measured to the week's last day, so a week's figures stay put when a later payment arrives.
export async function readProfitInput(q: Queryable, period: Period): Promise<ProfitInput> {
  const rows = await readReportInput(q, [
    "loads",
    "load_state_miles",
    "load_accessorials",
    "drivers",
    "customers",
    "pay_configs",
    "invoices",
    "customer_payments",
    "payment_applications",
  ]);
  const lines = marginLines(
    {
      loads: loadsOf(rows.loads, rows.load_state_miles, rows.load_accessorials),
      drivers: rows.drivers.map(driverOf),
      customers: rows.customers.map(customerOf),
      payConfigOn: payConfigOn(rows.pay_configs),
    },
    period,
  );
  return { lines, receivables: receivablesInputOf(rows, period.end) };
}

export type CustomerWeek = CustomerRollup & Omit<CustomerPaying, "customerId">;

export type UnpricedLoad = { loadId: string; loadNumber: string; note: string };

export type ProfitWeek = {
  period: Period;
  totals: ProfitTotals;
  // Every route and customer of the week, highest margin first. The figures list only the top
  // ones (profitBriefLimits), so the model's prompt stays small.
  routes: LaneRollup[];
  customers: CustomerWeek[];
  // Delivered loads the engine could not price, with the reason. They add to no sum.
  unpriced: UnpricedLoad[];
  figures: BriefFigure[];
};

export function profitWeek(input: ProfitInput, period: Period, limits: ProfitFigureLimits): ProfitWeek {
  const { lines, receivables } = input;
  const customers = rollupByCustomer(lines);
  const paying = new Map(
    customerPaying(
      customers.map((c) => c.customerId),
      receivables,
      period.end,
    ).map((p) => [p.customerId, p]),
  );
  return {
    period,
    totals: profitTotals(lines),
    routes: rollupByLane(lines),
    customers: customers.map((c) => {
      const p = paying.get(c.customerId);
      return { ...c, meanDays: p?.meanDays ?? null, paidCount: p?.paidCount ?? 0, habit: p?.habit ?? "mixed" };
    }),
    unpriced: lines
      .filter((l) => l.revenueCents === null || l.driverPayCents === null)
      .map((l) => ({ loadId: l.loadId, loadNumber: l.loadNumber, note: l.note ?? "Not priced" })),
    figures: profitFigures(lines, receivables, period, period.end, limits),
  };
}

// Basis points as a percent with two decimals: 3756 reads "37.56%", -125 reads "-1.25%". The same
// text the report tables show (components/agent/report-table.tsx formatBps).
export function bpsText(bps: number): string {
  const abs = Math.abs(bps);
  return `${bps < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}

// A figure's value as the prompt and the page write it.
export function figureValueText(figure: BriefFigure): string {
  if (typeof figure.value === "string") return figure.value;
  switch (figure.kind) {
    case "cents":
      return formatCents(figure.value);
    case "bps":
      return bpsText(figure.value);
    default:
      return String(figure.value);
  }
}

// The numbered list the model words: one figure a line, "[f1] Revenue: $48,210.00".
export function figuresText(figures: readonly BriefFigure[]): string {
  return figures.map((f) => `[${f.key}] ${f.label}: ${figureValueText(f)}`).join("\n");
}
