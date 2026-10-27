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
import type { Period } from "../time/local-date";

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

// One delivered load, priced by the engine: the numbers the report shows for it, plus the lane
// and miles the profit brief rolls up. A number the engine will not give is null and the note
// says why.
export type MarginLine = {
  loadId: string;
  loadNumber: string;
  deliveredOn: string;
  customerId: string | null;
  customerName: string | null;
  driverId: string | null;
  // "First Last (CODE)", as the report's driver cell labels it.
  driverName: string | null;
  lane: { originCity: string; originState: string; destCity: string; destState: string };
  loadedMiles: number;
  revenueCents: number | null;
  driverPayCents: number | null;
  marginCents: number | null;
  marginBps: number | null;
  note: string | null;
};

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
): MarginLine {
  const notes: string[] = [];
  const invoice = invoiceAmount(load);
  const revenue = invoice.ok ? invoice.amountCents : null;
  if (!invoice.ok) notes.push(NOTES[invoice.reason]);

  let pay: number | null = null;
  let driverName: string | null = null;
  if (load.driverId === null) {
    notes.push(NOTES.no_driver);
  } else {
    const driver = mustGet(drivers, load.driverId, "driver");
    driverName = driverCell(driver).label;
    const config = payConfigOn(deliveredOn);
    if (config === null) {
      notes.push(NOTES.no_pay_rules);
    } else {
      pay = driverPay(load, driver, config);
      if (pay === null && !notes.includes(NOTES.missing_rate)) notes.push(NOTES.missing_rate);
    }
  }

  let customerName: string | null = null;
  if (load.customerId !== null) customerName = mustGet(customers, load.customerId, "customer").name;

  const margin = revenue !== null && pay !== null ? sub(revenue, pay) : null;
  return {
    loadId: load.id,
    loadNumber: load.loadNumber,
    deliveredOn,
    customerId: load.customerId,
    customerName,
    driverId: load.driverId,
    driverName,
    lane: {
      originCity: load.originCity,
      originState: load.originState,
      destCity: load.destCity,
      destState: load.destState,
    },
    loadedMiles: load.loadedMiles,
    revenueCents: revenue,
    driverPayCents: pay,
    marginCents: margin,
    marginBps: margin === null || revenue === null ? null : ratioBps(margin, revenue),
    note: notes.length > 0 ? notes.join("; ") : null,
  };
}

// Every load delivered in the period (both ends included), optionally for one customer, priced
// by the engine, in delivery-day then load-number order. The report and the profit brief both
// read these, so they can never disagree on a load.
export function marginLines(input: MarginPerLoadInput, period: Period, customerId?: string): MarginLine[] {
  const drivers = byId(input.drivers, "drivers");
  const customers = byId(input.customers, "customers");
  const picked: { load: LoadRecord; day: string }[] = [];
  for (const load of input.loads) {
    const day = load.deliveredOn;
    if (!isDelivered(load) || day === null || day < period.start || day > period.end) continue;
    if (customerId && load.customerId !== customerId) continue;
    picked.push({ load, day });
  }
  picked.sort((a, b) => compareText(a.day, b.day) || compareText(a.load.loadNumber, b.load.loadNumber));
  return picked.map((p) => lineOf(p.load, p.day, drivers, customers, input.payConfigOn));
}

function rowOf(line: MarginLine): ReportRow {
  const customer: ReportCell =
    line.customerId === null || line.customerName === null
      ? null
      : { table: "customers", id: line.customerId, label: line.customerName };
  const driver: ReportCell =
    line.driverId === null || line.driverName === null
      ? null
      : { table: "drivers", id: line.driverId, label: line.driverName };
  return {
    load: { table: "loads", id: line.loadId, label: line.loadNumber },
    deliveredOn: line.deliveredOn,
    customer,
    driver,
    revenueCents: line.revenueCents,
    driverPayCents: line.driverPayCents,
    marginCents: line.marginCents,
    marginBps: line.marginBps,
    note: line.note,
  };
}

export function computeMarginPerLoad(
  input: MarginPerLoadInput,
  args: MarginPerLoadArgs,
  asOf: string,
): ReportResult {
  const lines = marginLines(input, { start: args.periodStart, end: args.periodEnd }, args.customerId);

  // The sums cover the loads with both numbers known, so revenue less pay equals the margin shown.
  // They are the Total only when every load is priced. Otherwise a load can show revenue it adds
  // nothing to (no driver, no pay rules), so the sums go on one row whose label says how many
  // loads they cover, and there is no Total row for a column to be read against.
  const known = lines.flatMap((l) =>
    l.revenueCents !== null && l.driverPayCents !== null ? [{ revenue: l.revenueCents, pay: l.driverPayCents }] : [],
  );
  const revenue = sum(known.map((l) => l.revenue));
  const pay = sum(known.map((l) => l.pay));
  const margin = sub(revenue, pay);
  const bps = ratioBps(margin, revenue);
  const sums: Record<string, number> = { revenueCents: revenue, driverPayCents: pay, marginCents: margin };
  if (bps !== null) sums.marginBps = bps;
  const coverage =
    known.length === lines.length
      ? { totals: sums }
      : { subtotals: [{ label: `Priced loads: ${known.length} of ${lines.length}`, totals: sums }] };

  return reportOf("margin_per_load", {
    asOf,
    args: argsOf({ periodStart: args.periodStart, periodEnd: args.periodEnd, customerId: args.customerId }),
    period: { start: args.periodStart, end: args.periodEnd },
    rows: lines.map(rowOf),
    ...coverage,
  });
}
