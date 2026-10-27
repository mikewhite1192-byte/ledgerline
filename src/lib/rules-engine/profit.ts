import { assertDate, compareText, InputError, type ReceivablesInput } from "./types";
import { mul, roundHalfUp, sub, sum } from "./money";
import { daysToPay, paymentProfile } from "./receivables";

// The profit brief's numbers (design 3.3): one closed pay week of priced loads, rolled up by route
// and by customer, plus how fast each customer pays. Pure: no database, clock or model. Every
// figure is integer cents, basis points or a whole count, computed here; the brief's words only
// ever repeat a figure this file emitted. A load the engine could not price (no rate, no driver,
// no pay rules) adds to no sum; it is counted and listed, never guessed.

// One delivered load as the margin report prices it (reports/margin-per-load.ts marginLines).
export type ProfitLine = {
  loadId: string;
  loadNumber: string;
  customerId: string | null;
  customerName: string | null;
  lane: { originCity: string; originState: string; destCity: string; destState: string };
  loadedMiles: number;
  revenueCents: number | null;
  driverPayCents: number | null;
  marginCents: number | null;
  note: string | null;
};

type Sums = {
  loads: number;
  revenueCents: number;
  driverPayCents: number;
  marginCents: number;
  // Margin over revenue, in basis points; null when there is no revenue to divide by.
  marginBps: number | null;
};

export type LaneRollup = Sums & {
  // "Roanoke, VA to Charlotte, NC". Each direction is its own route.
  route: string;
  lane: ProfitLine["lane"];
  loadedMiles: number;
  // Revenue per loaded mile, in cents; null with no loaded miles.
  centsPerLoadedMile: number | null;
};

export type CustomerRollup = Sums & { customerId: string; customerName: string };

export type ProfitTotals = Sums & { loadsDelivered: number };

// part / whole in basis points, rounded half up, sign kept; null when whole is not positive. The
// same arithmetic as the reports' ratioBps, so a margin percent here and in a report never differ.
export function marginBpsOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  const size = roundHalfUp(mul(Math.abs(part), 10_000, "part x 10000"), whole);
  return part < 0 ? -size : size;
}

export function routeOf(lane: ProfitLine["lane"]): string {
  return `${lane.originCity}, ${lane.originState} to ${lane.destCity}, ${lane.destState}`;
}

type Priced = ProfitLine & { revenueCents: number; driverPayCents: number; marginCents: number };

// Only a load with both numbers known is summed, so revenue less driver pay is the margin shown.
function priced(lines: readonly ProfitLine[]): Priced[] {
  return lines.filter(
    (l): l is Priced => l.revenueCents !== null && l.driverPayCents !== null && l.marginCents !== null,
  );
}

function sumsOf(lines: readonly Priced[]): Sums {
  const revenueCents = sum(lines.map((l) => l.revenueCents));
  const driverPayCents = sum(lines.map((l) => l.driverPayCents));
  const marginCents = sub(revenueCents, driverPayCents);
  return {
    loads: lines.length,
    revenueCents,
    driverPayCents,
    marginCents,
    marginBps: marginBpsOf(marginCents, revenueCents),
  };
}

function checkMax(max: number | undefined): number {
  if (max === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(max) || max < 1) throw new InputError("max is not a positive whole number");
  return max;
}

// Highest margin first; a tie goes to the name, so the order never depends on input order.
function byMargin<T extends Sums>(name: (row: T) => string) {
  return (a: T, b: T) => b.marginCents - a.marginCents || compareText(name(a), name(b));
}

export function profitTotals(lines: readonly ProfitLine[]): ProfitTotals {
  return { ...sumsOf(priced(lines)), loadsDelivered: lines.length };
}

// Priced loads by route, each direction apart, highest margin first, at most `max` rows.
export function rollupByLane(lines: readonly ProfitLine[], max?: number): LaneRollup[] {
  const limit = checkMax(max);
  const groups = new Map<string, Priced[]>();
  for (const line of priced(lines)) {
    const key = routeOf(line.lane);
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const rows: LaneRollup[] = [...groups].map(([route, group]) => {
    const sums = sumsOf(group);
    const loadedMiles = sum(group.map((l) => l.loadedMiles));
    return {
      ...sums,
      route,
      lane: group[0].lane,
      loadedMiles,
      centsPerLoadedMile:
        loadedMiles > 0 && sums.revenueCents >= 0 ? roundHalfUp(sums.revenueCents, loadedMiles) : null,
    };
  });
  return rows.sort(byMargin((r) => r.route)).slice(0, limit);
}

// Priced loads by customer, highest margin first, at most `max` rows. A load with no customer
// adds to the totals but to no customer row.
export function rollupByCustomer(lines: readonly ProfitLine[], max?: number): CustomerRollup[] {
  const limit = checkMax(max);
  const groups = new Map<string, Priced[]>();
  for (const line of priced(lines)) {
    if (line.customerId === null) continue;
    groups.set(line.customerId, [...(groups.get(line.customerId) ?? []), line]);
  }
  const rows: CustomerRollup[] = [...groups].map(([customerId, group]) => ({
    ...sumsOf(group),
    customerId,
    customerName: group[0].customerName ?? "",
  }));
  return rows.sort(byMargin((r) => r.customerName)).slice(0, limit);
}

// ---- The figures a brief may cite ----

export const FIGURE_KINDS = ["cents", "bps", "int", "date", "text"] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

// Where a figure comes from: one record, or a report run with these arguments.
export type FigureSource =
  | { table: "customers"; id: string }
  | { report: "margin_per_load"; args: { periodStart: string; periodEnd: string } };

// One figure, keyed f1..fN in order. `subject` is the route or customer the figure is about, as
// written in the label; the check reads it as a name, never as numbers.
export type BriefFigure = {
  key: string;
  label: string;
  kind: FigureKind;
  value: number | string;
  source: FigureSource;
  subject?: string;
};

export type ProfitFigureLimits = { maxLanes: number; maxCustomers: number };

export type CustomerPaying = {
  customerId: string;
  // Over invoices paid in the 180 days before asOf; null with none paid.
  meanDays: number | null;
  paidCount: number;
  habit: ReturnType<typeof paymentProfile>["label"];
};

// How each customer of the week pays, as of `asOf`.
export function customerPaying(
  customerIds: readonly string[],
  receivables: ReceivablesInput,
  asOf: string,
): CustomerPaying[] {
  return customerIds.map((id) => {
    const days = daysToPay(id, receivables, asOf);
    return {
      customerId: id,
      meanDays: days.meanDays,
      paidCount: days.paidCount,
      habit: paymentProfile(id, receivables, asOf).label,
    };
  });
}

// The numbered figure list for one week: the totals, then the top routes and customers by margin.
// `asOf` is the day the customers' paying is measured to (the week's last day, so a week's figures
// stay the same when a later payment arrives).
export function profitFigures(
  lines: readonly ProfitLine[],
  receivables: ReceivablesInput,
  period: { start: string; end: string },
  asOf: string,
  limits: ProfitFigureLimits,
): BriefFigure[] {
  assertDate(period.start, "period start");
  assertDate(period.end, "period end");
  const report: FigureSource = {
    report: "margin_per_load",
    args: { periodStart: period.start, periodEnd: period.end },
  };
  const out: BriefFigure[] = [];
  const add = (figure: Omit<BriefFigure, "key">) => out.push({ key: `f${out.length + 1}`, ...figure });

  const totals = profitTotals(lines);
  add({ label: "Revenue", kind: "cents", value: totals.revenueCents, source: report });
  add({ label: "Driver pay", kind: "cents", value: totals.driverPayCents, source: report });
  add({ label: "Margin", kind: "cents", value: totals.marginCents, source: report });
  if (totals.marginBps !== null) {
    add({ label: "Margin percent", kind: "bps", value: totals.marginBps, source: report });
  }
  add({ label: "Loads priced", kind: "int", value: totals.loads, source: report });
  add({ label: "Loads delivered", kind: "int", value: totals.loadsDelivered, source: report });

  for (const lane of rollupByLane(lines, limits.maxLanes)) {
    const about = { source: report, subject: lane.route };
    const label = (what: string) => `Route ${lane.route}: ${what}`;
    add({ ...about, label: label("loads"), kind: "int", value: lane.loads });
    add({ ...about, label: label("revenue"), kind: "cents", value: lane.revenueCents });
    add({ ...about, label: label("margin"), kind: "cents", value: lane.marginCents });
    if (lane.marginBps !== null) {
      add({ ...about, label: label("margin percent"), kind: "bps", value: lane.marginBps });
    }
    if (lane.centsPerLoadedMile !== null) {
      add({ ...about, label: label("revenue per loaded mile"), kind: "cents", value: lane.centsPerLoadedMile });
    }
  }

  const customers = rollupByCustomer(lines, limits.maxCustomers);
  const paying = new Map(
    customerPaying(
      customers.map((c) => c.customerId),
      receivables,
      asOf,
    ).map((p) => [p.customerId, p]),
  );
  for (const customer of customers) {
    const about = { source: { table: "customers", id: customer.customerId } as const, subject: customer.customerName };
    const label = (what: string) => `Customer ${customer.customerName}: ${what}`;
    add({ ...about, label: label("loads"), kind: "int", value: customer.loads });
    add({ ...about, label: label("revenue"), kind: "cents", value: customer.revenueCents });
    add({ ...about, label: label("margin"), kind: "cents", value: customer.marginCents });
    if (customer.marginBps !== null) {
      add({ ...about, label: label("margin percent"), kind: "bps", value: customer.marginBps });
    }
    const days = paying.get(customer.customerId)?.meanDays ?? null;
    if (days !== null) {
      add({ ...about, label: label("average days to pay"), kind: "int", value: days });
    }
  }
  return out;
}
