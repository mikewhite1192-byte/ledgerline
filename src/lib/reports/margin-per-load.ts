import {
  accessorialPay,
  compareText,
  invoiceAmount,
  isDelivered,
  loadPay,
  sub,
  sum,
  type CustomerRecord,
  type DriverRecord,
  type LoadRecord,
  type PayConfig,
} from "../rules-engine";
import { argsOf, byId, driverCell, mustGet, ratioBps, reportOf } from "./build";
import type { ReportCell, ReportResult, ReportRow } from "./types";

// What each delivered load earned against what its driver is paid for it, both from the engine:
// revenue is the invoice amount (invoiceAmount: linehaul, fuel surcharge and every accessorial,
// lumper included), driver pay is loadPay plus the accessorial share (accessorialPay) under the
// pay rules of the delivery week. A number the engine will not give (no rate, no customer, no
// driver, no pay rules yet) stays empty with a note, never a guess.

export type MarginPerLoadInput = {
  loads: readonly LoadRecord[];
  drivers: readonly DriverRecord[];
  customers: readonly CustomerRecord[];
  // The pay rules in force on a carrier-local day; null when no version covers it.
  payConfigOn: (day: string) => PayConfig | null;
};

export type MarginPerLoadArgs = { periodStart: string; periodEnd: string; customerId?: string };

const NOTES = {
  missing_rate: "No rate",
  missing_customer: "No customer",
  not_delivered: "Not delivered",
  no_driver: "No driver",
  no_pay_rules: "No pay rules",
} as const;

type Line = { row: ReportRow; revenue: number | null; pay: number | null };

function driverPay(
  load: LoadRecord,
  driver: DriverRecord,
  config: PayConfig,
): number | null {
  const { line, exception } = loadPay(config, driver, load);
  if (exception) return null;
  const share = accessorialPay(config, driver, load);
  return sum([line.amountCents, share?.amountCents ?? 0]);
}

function lineOf(
  load: LoadRecord,
  deliveredOn: string,
  drivers: Map<string, DriverRecord>,
  customers: Map<string, CustomerRecord>,
  payConfigOn: MarginPerLoadInput["payConfigOn"],
): Line {
  const notes: string[] = [];
  const invoice = invoiceAmount(load);
  const revenue = invoice.ok ? invoice.amountCents : null;
  if (!invoice.ok) notes.push(NOTES[invoice.reason]);

  let pay: number | null = null;
  let driverRef: ReportCell = null;
  if (load.driverId === null) {
    notes.push(NOTES.no_driver);
  } else {
    const driver = mustGet(drivers, load.driverId, "driver");
    driverRef = driverCell(driver);
    const config = payConfigOn(deliveredOn);
    if (config === null) {
      notes.push(NOTES.no_pay_rules);
    } else {
      pay = driverPay(load, driver, config);
      if (pay === null && !notes.includes(NOTES.missing_rate)) notes.push(NOTES.missing_rate);
    }
  }

  let customerRef: ReportCell = null;
  if (load.customerId !== null) {
    const customer = mustGet(customers, load.customerId, "customer");
    customerRef = { table: "customers", id: customer.id, label: customer.name };
  }

  const margin = revenue !== null && pay !== null ? sub(revenue, pay) : null;
  return {
    revenue,
    pay,
    row: {
      load: { table: "loads", id: load.id, label: load.loadNumber },
      deliveredOn,
      customer: customerRef,
      driver: driverRef,
      revenueCents: revenue,
      driverPayCents: pay,
      marginCents: margin,
      marginBps: margin === null || revenue === null ? null : ratioBps(margin, revenue),
      note: notes.length > 0 ? notes.join("; ") : null,
    },
  };
}

export function computeMarginPerLoad(
  input: MarginPerLoadInput,
  args: MarginPerLoadArgs,
  asOf: string,
): ReportResult {
  const drivers = byId(input.drivers, "drivers");
  const customers = byId(input.customers, "customers");
  const picked: { load: LoadRecord; day: string }[] = [];
  for (const load of input.loads) {
    const day = load.deliveredOn;
    if (!isDelivered(load) || day === null || day < args.periodStart || day > args.periodEnd) continue;
    if (args.customerId && load.customerId !== args.customerId) continue;
    picked.push({ load, day });
  }
  picked.sort((a, b) => compareText(a.day, b.day) || compareText(a.load.loadNumber, b.load.loadNumber));
  const lines = picked.map((p) => lineOf(p.load, p.day, drivers, customers, input.payConfigOn));

  // Totals cover the loads with both numbers known, so revenue less pay equals the margin shown.
  const known = lines.flatMap((l) => (l.revenue !== null && l.pay !== null ? [{ revenue: l.revenue, pay: l.pay }] : []));
  const revenue = sum(known.map((l) => l.revenue));
  const pay = sum(known.map((l) => l.pay));
  const margin = sub(revenue, pay);
  const bps = ratioBps(margin, revenue);
  const totals: Record<string, number> = { revenueCents: revenue, driverPayCents: pay, marginCents: margin };
  if (bps !== null) totals.marginBps = bps;

  return reportOf("margin_per_load", {
    asOf,
    args: argsOf({ periodStart: args.periodStart, periodEnd: args.periodEnd, customerId: args.customerId }),
    period: { start: args.periodStart, end: args.periodEnd },
    rows: lines.map((l) => l.row),
    totals,
  });
}
