import { sub, sum } from "./money";
import {
  customerPaying,
  profitTotals,
  type BriefFigure,
  type FigureSection,
  type FigureSource,
  type ProfitLine,
  type ProfitTotals,
} from "./profit";
import { ageReceivables } from "./receivables";
import { findUnbilledDetention } from "./detention";
import {
  assertDate,
  compareText,
  InputError,
  type CustomerRecord,
  type LoadStopsRecord,
  type PeriodStatus,
  type ReceivablesInput,
  type SettlementPeriodRecord,
  type SettlementRecord,
} from "./types";

// The quarter review's numbers (design 3.4): the calendar quarter so far, from its pay runs,
// invoices, payments, the agent's fixes and the detention it found. Pure: no database, clock or
// model. Every figure is integer cents, basis points or a whole count, computed here; the review's
// words only ever repeat a figure this file emitted. The figures run headline first and per-driver
// last, so a prompt cut from the bottom keeps what matters most.

// Drivers named in the figures: the most and the least net pay, this many each.
export const QUARTER_DRIVERS = 3;
// Customers named in the figures, most invoiced first.
export const QUARTER_CUSTOMERS = 12;

// A driver as the figures name them: first name and last initial ("Avery L."), never the full
// name, since the figures go to the model with each driver's net pay. A single name stays as is.
export function driverFigureName(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts[0]} ${Array.from(parts[parts.length - 1])[0]}.`;
}

// One of the agent's suggested fixes, with the carrier's own dates.
export type QuarterProposal = {
  id: string;
  kind: string;
  status: string;
  direction: string;
  amountCents: number;
  createdOn: string;
  decidedOn: string | null;
};

// A detention charge the agent found and a person approved: the charge row and its proposal.
export type QuarterDetentionCharge = {
  id: string;
  loadId: string;
  amountCents: number;
  proposalId: string;
  proposalStatus: string;
  decidedOn: string | null;
};

export type QuarterInput = {
  periods: readonly SettlementPeriodRecord[];
  settlements: readonly SettlementRecord[];
  lines: readonly { settlementId: string; kind: string; amountCents: number }[];
  drivers: readonly { id: string; name: string }[];
  customers: readonly CustomerRecord[];
  // Loads delivered from the quarter's first day to asOf, priced by the margin report's code.
  margin: readonly ProfitLine[];
  // As of asOf.
  receivables: ReceivablesInput;
  loads: readonly LoadStopsRecord[];
  accessorials: readonly { loadId: string; kind: string }[];
  proposals: readonly QuarterProposal[];
  detention: readonly QuarterDetentionCharge[];
};

export type QuarterPayRun = {
  periodId: string;
  start: string;
  end: string;
  status: PeriodStatus;
  paystubs: number;
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  // Problems the pay check found on the run's paystubs, and the paystubs with at least one.
  exceptionCount: number;
  withProblem: number;
};

export type QuarterCustomer = {
  customerId: string;
  customerName: string;
  invoices: number;
  invoicedCents: number;
  payments: number;
  receivedCents: number;
  openCents: number;
  meanDays: number | null;
  paidCount: number;
  habit: string;
};

export type QuarterDriver = { driverId: string; name: string; paystubs: number; netCents: number };

export type QuarterFixes = { kind: string; label: string; count: number; amountCents: number };

export type Quarter = {
  quarter: { start: string; end: string };
  asOf: string;
  // The quarter's first day to asOf: what "so far" covers.
  window: { start: string; end: string };
  // Oldest first. A pay run belongs to the quarter its last day falls in.
  payRuns: QuarterPayRun[];
  // Money sums cover the closed runs (approved or paid); an open run is still changing.
  pay: {
    runs: number;
    paid: number;
    approved: number;
    open: number;
    paystubs: number;
    drivers: number;
    grossCents: number;
    deductionsCents: number;
    netCents: number;
    exceptionCount: number;
    withProblem: number;
  };
  margin: ProfitTotals;
  invoiced: { count: number; cents: number };
  received: { count: number; cents: number };
  receivables: { openCents: number; pastDueCents: number };
  recovered: {
    totalCents: number;
    detentionCount: number;
    detentionCents: number;
    correctionsCount: number;
    correctionsCents: number;
    advancesCents: number;
  };
  exceptions: {
    suggested: number;
    done: number;
    waiting: number;
    declined: number;
    failed: number;
    byKind: QuarterFixes[];
    unbilledLoads: number;
    unbilledCents: number;
  };
  customers: QuarterCustomer[];
  // Every driver paid in a closed run, most net pay first.
  drivers: QuarterDriver[];
  figures: BriefFigure[];
};

// The agent's fixes in plain words. A kind this list does not know reads "Other fixes".
const FIX_WORDS: Record<string, string> = {
  advance_payout: "Fuel advances",
  pay_correction: "Pay corrections",
  invoice_fix: "Invoice fixes",
  load_rate_fill: "Missing load rates",
  invoice_post: "Invoices sent to the books",
  payment_reapply: "Payments moved to the right invoice",
  detention_charge: "Detention charges",
  settlement_approve: "Paystub approvals",
};

export function fixWords(kind: string): string {
  return Object.hasOwn(FIX_WORDS, kind) ? FIX_WORDS[kind] : "Other fixes";
}

const WAITING = new Set(["proposed", "approved", "executing"]);
const DECLINED = new Set(["rejected", "expired"]);
const CLOSED: ReadonlySet<PeriodStatus> = new Set<PeriodStatus>(["approved", "paid"]);

const inside = (date: string | null, window: { start: string; end: string }) =>
  date !== null && window.start <= date && date <= window.end;

function whole(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) throw new InputError(`${what} is not a whole number`);
  return value;
}

export function quarterOf(
  input: QuarterInput,
  quarter: { start: string; end: string },
  asOf: string,
): Quarter {
  assertDate(quarter.start, "quarter start");
  assertDate(quarter.end, "quarter end");
  assertDate(asOf, "asOf");
  if (asOf < quarter.start || asOf > quarter.end) throw new InputError("asOf is not inside the quarter");
  if (input.receivables.asOf !== asOf) throw new InputError("the receivables are not as of asOf");
  const window = { start: quarter.start, end: asOf };

  // ---- Pay runs ----
  const periods = input.periods
    .filter((p) => inside(p.periodEnd, quarter) && p.periodStart <= asOf)
    .sort((a, b) => compareText(a.periodStart, b.periodStart) || compareText(a.id, b.id));
  const byPeriod = new Map<string, SettlementRecord[]>();
  for (const s of input.settlements) byPeriod.set(s.periodId, [...(byPeriod.get(s.periodId) ?? []), s]);
  const payRuns: QuarterPayRun[] = periods.map((p) => {
    const stubs = byPeriod.get(p.id) ?? [];
    return {
      periodId: p.id,
      start: p.periodStart,
      end: p.periodEnd,
      status: p.status,
      paystubs: stubs.length,
      grossCents: sum(stubs.map((s) => s.grossCents)),
      deductionsCents: sum(stubs.map((s) => s.deductionsCents)),
      netCents: sum(stubs.map((s) => s.netCents)),
      exceptionCount: sum(stubs.map((s) => whole(s.exceptionCount, "exception count"))),
      withProblem: stubs.filter((s) => s.exceptionCount > 0).length,
    };
  });
  const closedRuns = payRuns.filter((r) => CLOSED.has(r.status));
  const closedIds = new Set(closedRuns.map((r) => r.periodId));
  const closedStubs = input.settlements.filter((s) => closedIds.has(s.periodId));
  const pay = {
    runs: payRuns.length,
    paid: payRuns.filter((r) => r.status === "paid").length,
    approved: payRuns.filter((r) => r.status === "approved").length,
    open: payRuns.filter((r) => r.status === "open").length,
    paystubs: closedStubs.length,
    drivers: new Set(closedStubs.map((s) => s.driverId)).size,
    grossCents: sum(closedRuns.map((r) => r.grossCents)),
    deductionsCents: sum(closedRuns.map((r) => r.deductionsCents)),
    netCents: sum(closedRuns.map((r) => r.netCents)),
    exceptionCount: sum(closedRuns.map((r) => r.exceptionCount)),
    withProblem: sum(closedRuns.map((r) => r.withProblem)),
  };

  // ---- Money in ----
  const issued = input.receivables.invoices.filter((i) => i.status !== "void" && inside(i.issuedOn, window));
  const paidIn = input.receivables.payments.filter((p) => inside(p.receivedOn, window));
  const aging = ageReceivables(input.receivables);
  const openCents = sum(Object.values(aging.totals));
  const pastDueCents = sub(openCents, aging.totals.current);

  // ---- Money recovered ----
  const detention = input.detention.filter((d) => d.proposalStatus === "done" && inside(d.decidedOn, window));
  const corrections = input.proposals.filter(
    (p) => p.kind === "pay_correction" && p.status === "done" && p.direction === "in" && inside(p.decidedOn, window),
  );
  const closedStubIds = new Set(closedStubs.map((s) => s.id));
  // Recovery lines are deductions, written below zero: the money recovered is their size.
  const advancesCents = sub(
    0,
    sum(input.lines.filter((l) => l.kind === "advance_recovery" && closedStubIds.has(l.settlementId)).map((l) => l.amountCents)),
  );
  const detentionCents = sum(detention.map((d) => whole(d.amountCents, "detention amount")));
  const correctionsCents = sum(corrections.map((p) => whole(p.amountCents, "correction amount")));
  const recovered = {
    totalCents: sum([detentionCents, correctionsCents, advancesCents]),
    detentionCount: detention.length,
    detentionCents,
    correctionsCount: corrections.length,
    correctionsCents,
    advancesCents,
  };

  // ---- Exceptions ----
  const fixes = input.proposals.filter((p) => inside(p.createdOn, window));
  const kinds = new Map<string, QuarterFixes>();
  for (const p of fixes) {
    const label = fixWords(p.kind);
    const row = kinds.get(label) ?? { kind: Object.hasOwn(FIX_WORDS, p.kind) ? p.kind : "other", label, count: 0, amountCents: 0 };
    row.count += 1;
    row.amountCents = sum([row.amountCents, whole(p.amountCents, "fix amount")]);
    kinds.set(label, row);
  }
  const unbilled = findUnbilledDetention(input.loads, input.customers, input.accessorials, window);
  const exceptions = {
    suggested: fixes.length,
    done: fixes.filter((p) => p.status === "done").length,
    waiting: fixes.filter((p) => WAITING.has(p.status)).length,
    declined: fixes.filter((p) => DECLINED.has(p.status)).length,
    failed: fixes.filter((p) => p.status === "failed").length,
    byKind: [...kinds.values()].sort((a, b) => b.count - a.count || compareText(a.label, b.label)),
    unbilledLoads: unbilled.length,
    unbilledCents: sum(unbilled.map((u) => u.amountCents)),
  };

  // ---- Customers ----
  const names = new Map(input.customers.map((c) => [c.id, c.name]));
  const openBy = new Map(aging.byCustomer.map((c) => [c.customerId, sum(Object.values(c.buckets))]));
  const ids = new Set<string>([...issued.map((i) => i.customerId), ...paidIn.map((p) => p.customerId), ...openBy.keys()]);
  const paying = new Map(customerPaying([...ids], input.receivables, asOf).map((p) => [p.customerId, p]));
  const customers: QuarterCustomer[] = [...ids]
    .map((id) => {
      const mine = issued.filter((i) => i.customerId === id);
      const theirs = paidIn.filter((p) => p.customerId === id);
      const p = paying.get(id);
      return {
        customerId: id,
        customerName: names.get(id) ?? "",
        invoices: mine.length,
        invoicedCents: sum(mine.map((i) => i.amountCents)),
        payments: theirs.length,
        receivedCents: sum(theirs.map((t) => t.amountCents)),
        openCents: openBy.get(id) ?? 0,
        meanDays: p?.meanDays ?? null,
        paidCount: p?.paidCount ?? 0,
        habit: p?.habit ?? "mixed",
      };
    })
    .sort(
      (a, b) =>
        b.invoicedCents - a.invoicedCents ||
        b.openCents - a.openCents ||
        compareText(a.customerName, b.customerName) ||
        compareText(a.customerId, b.customerId),
    );

  // ---- Drivers ----
  const driverNames = new Map(input.drivers.map((d) => [d.id, d.name]));
  const perDriver = new Map<string, SettlementRecord[]>();
  for (const s of closedStubs) perDriver.set(s.driverId, [...(perDriver.get(s.driverId) ?? []), s]);
  const drivers: QuarterDriver[] = [...perDriver]
    .map(([driverId, stubs]) => ({
      driverId,
      name: driverNames.get(driverId) ?? "",
      paystubs: stubs.length,
      netCents: sum(stubs.map((s) => s.netCents)),
    }))
    .sort((a, b) => b.netCents - a.netCents || compareText(a.name, b.name) || compareText(a.driverId, b.driverId));

  const base = {
    quarter: { start: quarter.start, end: quarter.end },
    asOf,
    window,
    payRuns,
    pay,
    margin: profitTotals(input.margin),
    invoiced: { count: issued.length, cents: sum(issued.map((i) => i.amountCents)) },
    received: { count: paidIn.length, cents: sum(paidIn.map((p) => p.amountCents)) },
    receivables: { openCents, pastDueCents },
    recovered,
    exceptions,
    customers,
    drivers,
  };
  return { ...base, figures: quarterFigures(base) };
}

// The numbered figure list, headline first: pay runs, margin, money in, what the carrier is owed,
// money recovered, the exceptions, then customers, then the drivers with the most and the least
// net pay, each by first name and last initial. Labels hold no digits, so words copied from a
// label never carry an untagged number.
export function quarterFigures(q: Omit<Quarter, "figures">): BriefFigure[] {
  const out: BriefFigure[] = [];
  const add = (figure: Omit<BriefFigure, "key">) => out.push({ key: `f${out.length + 1}`, ...figure });
  const section = (name: FigureSection): FigureSource => ({ section: name });

  const runs = section("pay_runs");
  add({ label: "Pay runs so far", kind: "int", value: q.pay.runs, source: runs });
  add({ label: "Pay runs paid", kind: "int", value: q.pay.paid, source: runs });
  if (q.pay.approved > 0) {
    add({ label: "Pay runs approved, not paid yet", kind: "int", value: q.pay.approved, source: runs });
  }
  add({ label: "Pay runs still open", kind: "int", value: q.pay.open, source: runs });
  add({ label: "Paystubs in closed pay runs", kind: "int", value: q.pay.paystubs, source: runs });
  add({ label: "Drivers paid", kind: "int", value: q.pay.drivers, source: runs });
  add({ label: "Gross pay, closed pay runs", kind: "cents", value: q.pay.grossCents, source: runs });
  add({ label: "Deductions, closed pay runs", kind: "cents", value: q.pay.deductionsCents, source: runs });
  add({ label: "Net pay, closed pay runs", kind: "cents", value: q.pay.netCents, source: runs });

  const report: FigureSource = {
    report: "margin_per_load",
    args: { periodStart: q.window.start, periodEnd: q.window.end },
  };
  add({ label: "Loads delivered", kind: "int", value: q.margin.loadsDelivered, source: report });
  add({ label: "Loads priced", kind: "int", value: q.margin.loads, source: report });
  add({ label: "Revenue from priced loads", kind: "cents", value: q.margin.revenueCents, source: report });
  add({ label: "Driver pay on priced loads", kind: "cents", value: q.margin.driverPayCents, source: report });
  add({ label: "Margin on priced loads", kind: "cents", value: q.margin.marginCents, source: report });
  if (q.margin.marginBps !== null) {
    add({ label: "Margin as a share of revenue", kind: "bps", value: q.margin.marginBps, source: report });
  }

  const money = section("customers");
  add({ label: "Invoices issued", kind: "int", value: q.invoiced.count, source: money });
  add({ label: "Revenue invoiced", kind: "cents", value: q.invoiced.cents, source: money });
  add({ label: "Customer payments", kind: "int", value: q.received.count, source: money });
  add({ label: "Payments received", kind: "cents", value: q.received.cents, source: money });

  const aging: FigureSource = { report: "ar_aging", args: { asOf: q.asOf } };
  add({ label: "Open receivables", kind: "cents", value: q.receivables.openCents, source: aging });
  add({ label: "Open receivables past due", kind: "cents", value: q.receivables.pastDueCents, source: aging });

  const back = section("recovered");
  add({ label: "Money recovered", kind: "cents", value: q.recovered.totalCents, source: back });
  add({ label: "Detention charges recovered", kind: "int", value: q.recovered.detentionCount, source: back });
  add({ label: "Detention recovered", kind: "cents", value: q.recovered.detentionCents, source: back });
  add({ label: "Pay corrections recovered", kind: "int", value: q.recovered.correctionsCount, source: back });
  add({ label: "Pay recovered by corrections", kind: "cents", value: q.recovered.correctionsCents, source: back });
  add({ label: "Advances recovered from pay", kind: "cents", value: q.recovered.advancesCents, source: back });

  const ex = section("exceptions");
  add({ label: "Paystub problems found", kind: "int", value: q.pay.exceptionCount, source: ex });
  add({ label: "Paystubs with a problem", kind: "int", value: q.pay.withProblem, source: ex });
  add({ label: "Loads with detention not billed", kind: "int", value: q.exceptions.unbilledLoads, source: ex });
  add({ label: "Detention not billed", kind: "cents", value: q.exceptions.unbilledCents, source: ex });
  add({ label: "Fixes the agent suggested", kind: "int", value: q.exceptions.suggested, source: ex });
  add({ label: "Fixes done", kind: "int", value: q.exceptions.done, source: ex });
  add({ label: "Fixes waiting for a decision", kind: "int", value: q.exceptions.waiting, source: ex });
  add({ label: "Fixes turned down", kind: "int", value: q.exceptions.declined, source: ex });
  if (q.exceptions.failed > 0) {
    add({ label: "Fixes that failed", kind: "int", value: q.exceptions.failed, source: ex });
  }
  for (const k of q.exceptions.byKind) {
    add({ label: `${k.label}: suggested`, kind: "int", value: k.count, source: ex });
    if (k.amountCents > 0) add({ label: `${k.label}: amount`, kind: "cents", value: k.amountCents, source: ex });
  }

  for (const c of q.customers.slice(0, QUARTER_CUSTOMERS)) {
    const about = { source: { table: "customers", id: c.customerId } as const, subject: c.customerName };
    const label = (what: string) => `Customer ${c.customerName}: ${what}`;
    add({ ...about, label: label("invoiced"), kind: "cents", value: c.invoicedCents });
    add({ ...about, label: label("payments received"), kind: "cents", value: c.receivedCents });
    add({ ...about, label: label("open balance"), kind: "cents", value: c.openCents });
    if (c.meanDays !== null) add({ ...about, label: label("average days to pay"), kind: "int", value: c.meanDays });
  }

  const top = q.drivers.slice(0, QUARTER_DRIVERS);
  const shown = new Set(top.map((d) => d.driverId));
  const bottom = q.drivers
    .slice(-QUARTER_DRIVERS)
    .filter((d) => !shown.has(d.driverId))
    .reverse();
  for (const [d, rank] of [...top.map((d) => [d, "most"] as const), ...bottom.map((d) => [d, "least"] as const)]) {
    // The subject is the name as the label writes it, so the check reads that name as a name.
    const name = driverFigureName(d.name);
    const about = { source: { table: "drivers", id: d.driverId } as const, subject: name };
    add({ ...about, label: `Driver ${name} (${rank} net pay): net pay`, kind: "cents", value: d.netCents });
    add({ ...about, label: `Driver ${name} (${rank} net pay): paystubs`, kind: "int", value: d.paystubs });
  }
  return out;
}
