import { addDays, dayOfWeek, daysBetween, type LocalDate, type Period } from "../time/local-date";
import { cents, mulBps, sub, sum } from "./money";
import { compareFactoringLines, factoringLineOf, factoringOptionOf } from "./factoring";
import { invoiceStatus, paymentProfile } from "./receivables";
import { settleDriver } from "./settlement";
import {
  assertDate,
  compareText,
  InputError,
  type BillDeferOption,
  type CashFigures,
  type CashFridayInput,
  type CashFridayLimits,
  type CashFridayResult,
  type CashOption,
  type CashRefusal,
  type Cents,
  type ChaseLine,
  type ChaseOption,
  type CustomerPaymentRecord,
  type FactoringLine,
  type FactoringOption,
  type InvoiceRecord,
  type PaymentApplicationRecord,
  type PaymentLabel,
  type PaymentProfile,
  type ReceiptLine,
  type ReceiptStatus,
  type ReceivablesInput,
  type SettlementInput,
  type SettlementPeriodRecord,
  type SourceRef,
  type VendorBillRecord,
} from "./types";

// Cash Friday (design docs/design-cash-friday.md, section 3): can the bank cover the open week's
// pay run on pay day, with the fuel card loads not yet out and the bills due by then? Every figure
// is integer cents from the records given; dates are tenant-local, converted by the caller; no
// clock and no I/O. A short builds up to three kinds of option (factor invoices, delay a flexible
// bill, chase late payers), each sized here so a person approves numbers the engine computed.

// A customer with nothing paid yet is expected this many days late, by its label.
export const TYPICAL_DAYS_LATE_DEFAULT: Readonly<Record<PaymentLabel, number>> = {
  reliable: 0,
  mixed: 7,
  repeat_late: 35,
};
// A customer with nothing paid yet counts at half its open balance.
export const NO_HISTORY_ON_TIME_BPS = 5000;
// Invoices one chase option lists.
export const CHASE_INVOICES_MAX = 8;
// A deferred bill moves to a week after pay day.
export const DEFER_DAYS = 7;

const STATUS_ORDER: Readonly<Record<ReceiptStatus, number>> = { counted: 0, after_pay_day: 1, stalled: 2 };

function refuse(refusal: CashRefusal): CashFridayResult {
  return { ok: false, refusal };
}

function checkLimits(limits: CashFridayLimits): CashFridayLimits {
  for (const [name, value] of Object.entries(limits ?? {})) {
    if (!Number.isSafeInteger(value) || value < 0) throw new InputError(`limit ${name} is not a whole number`);
  }
  return limits;
}

// The first day of the week numbered dow (0 is Sunday) after the period ends. With asOf, a pay
// day already behind asOf (the week is still open after it) moves to the next such day on or
// after asOf: the open pay run cannot go out before then, so that is the day to plan cash for.
export function payDayFor(period: Period, dow: number, asOf?: LocalDate): LocalDate {
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw new InputError("pay day must be 0 to 6");
  const end = assertDate(period.end, "period end");
  const ahead = (dow - dayOfWeek(end) + 7) % 7;
  const scheduled = addDays(end, ahead === 0 ? 7 : ahead);
  if (asOf === undefined || scheduled >= asOf) return scheduled;
  const today = assertDate(asOf, "asOf");
  return addDays(today, (dow - dayOfWeek(today) + 7) % 7);
}

// The customer's usual lateness: its median days late rounded half up (Math.round rounds .5 up,
// negatives included: -1.5 is -1), or the label's default when nothing is paid yet. Adding 0
// turns Math.round's -0 into 0.
export function typicalDaysLate(profile: PaymentProfile): number {
  return profile.medianDaysLate === null
    ? TYPICAL_DAYS_LATE_DEFAULT[profile.label]
    : Math.round(profile.medianDaysLate) + 0;
}

// The share of a customer's paid invoices paid on time, in basis points.
export function onTimeBps(profile: PaymentProfile): number {
  return profile.paidCount === 0 ? NO_HISTORY_ON_TIME_BPS : 10000 - profile.lateShareBps;
}

export type OpenInvoice = { invoice: InvoiceRecord; balanceCents: Cents };

// Every invoice that is not void and still owes money, with its balance from the applications.
export function openInvoices(input: Pick<CashFridayInput, "invoices" | "applications">): OpenInvoice[] {
  const applied = new Map<string, number>();
  for (const a of input.applications) applied.set(a.invoiceId, sum([applied.get(a.invoiceId) ?? 0, a.amountCents]));
  const out: OpenInvoice[] = [];
  for (const invoice of input.invoices) {
    if (invoice.status === "void") continue;
    const { balanceCents } = invoiceStatus(invoice.amountCents, applied.get(invoice.id) ?? 0);
    if (balanceCents > 0) out.push({ invoice, balanceCents });
  }
  return out;
}

function profilesFor(
  open: readonly OpenInvoice[],
  receivables: ReceivablesInput,
  asOf: LocalDate,
): Map<string, PaymentProfile> {
  const out = new Map<string, PaymentProfile>();
  for (const { invoice } of open) {
    if (!out.has(invoice.customerId)) out.set(invoice.customerId, paymentProfile(invoice.customerId, receivables, asOf));
  }
  return out;
}

// One line per open invoice: counted (expected by pay day, at the customer's on-time share),
// after pay day, or stalled (past due and already later than this customer usually is, plus the
// grace days). An invoice not yet due is never stalled: a customer who usually pays well before
// the due date is early, not late, until that date passes.
export function expectedReceipts(
  open: readonly OpenInvoice[],
  profiles: ReadonlyMap<string, PaymentProfile>,
  asOf: LocalDate,
  payDay: LocalDate,
  graceDays: number,
): ReceiptLine[] {
  const lines = open.map(({ invoice, balanceCents }): ReceiptLine => {
    const profile = profiles.get(invoice.customerId);
    if (!profile) throw new InputError(`invoice ${invoice.id} has no payment profile`);
    const typical = typicalDaysLate(profile);
    const bps = onTimeBps(profile);
    const due = addDays(invoice.dueOn, typical);
    const expectedOn = due > asOf ? due : asOf;
    const daysLate = daysBetween(invoice.dueOn, asOf);
    const stalled = daysLate > 0 && daysLate > typical + graceDays;
    const status: ReceiptStatus = stalled ? "stalled" : expectedOn <= payDay ? "counted" : "after_pay_day";
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      balanceCents,
      dueOn: invoice.dueOn,
      expectedOn,
      typicalDaysLate: typical,
      onTimeBps: bps,
      label: profile.label,
      status,
      expectedCents: status === "counted" ? mulBps(balanceCents, bps) : cents(0),
      sources: [
        { table: "invoices", id: invoice.id },
        { table: "customers", id: invoice.customerId },
      ],
    };
  });
  return lines.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      compareText(a.expectedOn, b.expectedOn) ||
      compareText(a.invoiceNumber, b.invoiceNumber) ||
      compareText(a.invoiceId, b.invoiceId),
  );
}

// Each customer's payments received since the balance date, the part not yet applied to an
// invoice: already in cash on hand, while the open balances it will pay still show it owed.
function unappliedSince(
  paymentsSince: readonly CustomerPaymentRecord[],
  applications: readonly PaymentApplicationRecord[],
): Map<string, { cents: Cents; sources: SourceRef[] }> {
  const applied = new Map<string, Cents>();
  for (const a of applications) applied.set(a.paymentId, sum([applied.get(a.paymentId) ?? 0, a.amountCents]));
  const unapplied = new Map<string, { cents: Cents; sources: SourceRef[] }>();
  for (const p of paymentsSince) {
    const left = sub(p.amountCents, applied.get(p.id) ?? 0);
    if (left <= 0) continue;
    const own = unapplied.get(p.customerId);
    unapplied.set(p.customerId, {
      cents: sum([own?.cents ?? 0, left]),
      sources: [...(own?.sources ?? []), { table: "customer_payments", id: p.id }],
    });
  }
  return unapplied;
}

// A payment received since the balance date is already in cash on hand. The part of it not yet
// applied to an invoice still sits in that customer's open balances, so it would count a second
// time as expected: it comes off that customer's counted lines, in line order, never below zero.
// Each dollar counts once.
function lessUnappliedSince(
  lines: readonly ReceiptLine[],
  paymentsSince: readonly CustomerPaymentRecord[],
  applications: readonly PaymentApplicationRecord[],
): ReceiptLine[] {
  const unapplied = unappliedSince(paymentsSince, applications);
  return lines.map((line) => {
    const own = unapplied.get(line.customerId);
    if (!own || own.cents <= 0 || line.expectedCents <= 0) return line;
    const take = own.cents < line.expectedCents ? own.cents : line.expectedCents;
    own.cents = sub(own.cents, take);
    return { ...line, expectedCents: sub(line.expectedCents, take), sources: [...line.sources, ...own.sources] };
  });
}

// Within (after, through]: left the bank after the balance date, on or before today.
function within(on: LocalDate | null, after: LocalDate, through: LocalDate): boolean {
  return on !== null && on > after && on <= through;
}

// Bills still to pay by pay day: open ones due by then, and deferred ones on their new date.
export function billsDue(bills: readonly VendorBillRecord[], payDay: LocalDate): VendorBillRecord[] {
  return bills.filter(
    (b) =>
      (b.status === "open" && b.dueOn <= payDay) ||
      (b.status === "deferred" && b.deferredTo !== null && b.deferredTo <= payDay),
  );
}

// The open week's pay run: the stored draft and approved nets when the week has any, else the
// engine's own preview over every driver active in the week. A stored run counts only when it is
// whole: every driver active in the week has a row for the week (any status; a paid row has
// already left the bank), or the engine finds nothing to pay them, as the run skips such a driver.
// A run that stopped partway (the per-run cap, a driver whose records failed) or a driver who
// started after it is unknown, never the part that was stored. So is a week whose drivers could
// not be read, and a preview that cannot be computed: unknown, never zero.
function payRunTotal(
  input: CashFridayInput,
  period: SettlementPeriodRecord,
): { source: "stored" | "preview"; cents: Cents; sources: SourceRef[] } | null {
  const week = input.previews;
  if (week === null) return null;
  if (week.some((p) => p.period.start !== period.periodStart || p.period.end !== period.periodEnd)) return null;
  const netOf = (preview: SettlementInput): Cents | null => {
    try {
      return settleDriver(preview).netCents;
    } catch {
      return null;
    }
  };
  const stored = input.settlements.filter(
    (s) => s.periodId === period.id && (s.status === "draft" || s.status === "approved"),
  );
  if (stored.length > 0) {
    const rowed = new Set(input.settlements.filter((s) => s.periodId === period.id).map((s) => s.driverId));
    if (week.some((p) => !rowed.has(p.driver.id) && netOf(p) !== 0)) return null;
    return {
      source: "stored",
      cents: sum(stored.map((s) => s.netCents)),
      sources: stored.map((s) => ({ table: "settlements", id: s.id })),
    };
  }
  const nets: Cents[] = [];
  for (const preview of week) {
    const net = netOf(preview);
    if (net === null) return null;
    nets.push(net);
  }
  return { source: "preview", cents: sum(nets), sources: week.map((p) => ({ table: "drivers", id: p.driver.id })) };
}

// Option 1: factor the largest load invoices not expected by pay day and issued recently; up to the
// limit, stopping once the net covers the short. Only invoices the engine does not count by pay
// day qualify, so every cent of the net is cash Friday would not otherwise have. A customer who
// usually pays late is not excluded: the partner's fee and reserve price that, and it is exactly
// the invoice a carrier factors.
export function factoringOption(
  lines: readonly ReceiptLine[],
  invoices: ReadonlyMap<string, InvoiceRecord>,
  settings: { factoringAdvanceBps: number; factoringFeeBps: number },
  period: SettlementPeriodRecord,
  asOf: LocalDate,
  shortCents: number,
  limits: CashFridayLimits,
): FactoringOption | null {
  const eligible = lines
    .filter((l) => {
      const invoice = invoices.get(l.invoiceId);
      // An invoice already on a live factoring line is never offered again.
      if (!invoice || invoice.source !== "load" || invoice.factored === true) return false;
      const age = daysBetween(invoice.issuedOn, asOf);
      return l.status === "after_pay_day" && age >= 0 && age <= limits.factoringMaxAgeDays;
    })
    .map((l) =>
      factoringLineOf({ id: l.invoiceId, invoiceNumber: l.invoiceNumber, customerId: l.customerId }, l.balanceCents, settings),
    )
    .sort(compareFactoringLines);
  const picked: FactoringLine[] = [];
  let net = cents(0);
  for (const line of eligible) {
    if (picked.length >= limits.maxFactorInvoices || net >= shortCents) break;
    picked.push(line);
    net = sum([net, line.netCents]);
  }
  if (picked.length === 0 || net <= 0) return null;
  return factoringOptionOf(picked, settings, period, shortCents);
}

// Option 2: move the largest open flexible bill due by pay day to a week after pay day.
export function billDeferOption(
  bills: readonly VendorBillRecord[],
  payDay: LocalDate,
  shortCents: number,
): BillDeferOption | null {
  const [bill] = bills
    .filter((b) => b.status === "open" && b.urgency === "flexible" && b.dueOn <= payDay)
    .sort((a, b) => b.amountCents - a.amountCents || compareText(a.billRef, b.billRef) || compareText(a.id, b.id));
  if (!bill) return null;
  return {
    kind: "bill_defer",
    subjectTable: "vendor_bills",
    subjectId: bill.id,
    direction: "none",
    amountCents: bill.amountCents,
    billRef: bill.billRef,
    dueOn: bill.dueOn,
    deferredTo: addDays(payDay, DEFER_DAYS),
    coversShort: bill.amountCents >= shortCents,
    sources: [{ table: "vendor_bills", id: bill.id }],
  };
}

// Option 3: one card per customer with a past-due open balance, the largest balances first. A
// past-due invoice can still be counted by pay day (a customer who usually pays late), and a
// payment since the balance date not yet applied is already cash on hand, so the card's new cash
// is its balances less both: only that part can close the short.
export function chaseOptions(
  open: readonly OpenInvoice[],
  profiles: ReadonlyMap<string, PaymentProfile>,
  asOf: LocalDate,
  limit: number,
  counted: {
    lines: readonly ReceiptLine[];
    unapplied: ReadonlyMap<string, { cents: Cents }>;
    shortCents: number;
  },
): ChaseOption[] {
  const expected = new Map(counted.lines.map((l) => [l.invoiceId, l.expectedCents]));
  const byCustomer = new Map<string, { lines: ChaseLine[]; expected: Cents[] }>();
  for (const { invoice, balanceCents } of open) {
    const daysLate = daysBetween(invoice.dueOn, asOf);
    if (daysLate <= 0) continue;
    const own = byCustomer.get(invoice.customerId) ?? { lines: [], expected: [] };
    const expectedCents = expected.get(invoice.id);
    if (expectedCents === undefined) throw new InputError(`invoice ${invoice.id} has no receipt line`);
    own.lines.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      balanceCents,
      dueOn: invoice.dueOn,
      daysLate,
    });
    own.expected.push(expectedCents);
    byCustomer.set(invoice.customerId, own);
  }
  return [...byCustomer.entries()]
    .map(([customerId, own]) => ({
      customerId,
      all: own.lines,
      total: sum(own.lines.map((l) => l.balanceCents)),
      already: sum([...own.expected, counted.unapplied.get(customerId)?.cents ?? 0]),
    }))
    .sort((a, b) => b.total - a.total || compareText(a.customerId, b.customerId))
    .slice(0, limit)
    .map(({ customerId, all, total, already }): ChaseOption => {
      const profile = profiles.get(customerId);
      if (!profile) throw new InputError(`customer ${customerId} has no payment profile`);
      const listed = [...all]
        .sort((a, b) => b.daysLate - a.daysLate || compareText(a.invoiceNumber, b.invoiceNumber))
        .slice(0, CHASE_INVOICES_MAX);
      const newCashCents = total > already ? sub(total, already) : cents(0);
      return {
        kind: "collections_chase",
        subjectTable: "customers",
        subjectId: customerId,
        direction: "in",
        amountCents: total,
        newCashCents,
        coversShort: newCashCents >= counted.shortCents,
        label: profile.label,
        overdueInvoices: all.length,
        invoices: listed,
        sources: [
          { table: "customers", id: customerId },
          ...listed.map((l): SourceRef => ({ table: "invoices", id: l.invoiceId })),
        ],
      };
    });
}

// The week paid next (D-090): the oldest open week that holds a paystub or a day that carries pay
// (payDays: a load delivered, a pay item, a day worked), else the newest open week. An open week
// with neither never finishes (the roll-up closes a week only from its stubs, and a run of it
// makes none), so it never holds the week paid next back while a newer week has pay to run; a
// week with pay and no stub yet (the seeded week before its first run) still comes first. With
// one open week, that week. Null when no week is open. Cash Friday, its previews and the cash
// needed report all read the week here, so they describe one week.
export function dueWeek<P extends { id: string; periodStart: LocalDate; periodEnd: LocalDate; status: string }>(
  periods: readonly P[],
  settlements: readonly { periodId: string }[],
  payDays: readonly LocalDate[] = [],
): P | null {
  const open = periods.filter((p) => p.status === "open").sort((a, b) => compareText(a.periodStart, b.periodStart));
  const held = new Set(settlements.map((s) => s.periodId));
  const paid = (p: P) => held.has(p.id) || payDays.some((d) => d >= p.periodStart && d <= p.periodEnd);
  return open.find(paid) ?? open[open.length - 1] ?? null;
}

export function computeCashFriday(input: CashFridayInput, asOfDate: LocalDate): CashFridayResult {
  const asOf = assertDate(asOfDate, "asOf");
  const limits = checkLimits(input.limits);
  const settings = input.settings;
  if (!settings) return refuse("balance_missing");
  const balanceAsOf = assertDate(settings.balanceAsOf, "balance date");
  if (balanceAsOf > asOf) return refuse("balance_in_future");
  // With two open weeks (D-090), the week paid next (dueWeek).
  const period = dueWeek(input.periods, input.settlements, input.payDays ?? []);
  if (!period) return refuse("no_open_period");
  const payDay = payDayFor({ start: period.periodStart, end: period.periodEnd }, settings.payDayDow, asOf);
  const payRun = payRunTotal(input, period);
  if (!payRun) return refuse("pay_run_unknown");

  const paymentsSince = input.payments.filter((p) => within(p.receivedOn, balanceAsOf, asOf));
  const advancesSince = input.advances.filter((a) => within(a.paidOn, balanceAsOf, asOf));
  const settlementsSince = input.settlements.filter((s) => within(s.paidOn, balanceAsOf, asOf));
  // A bill paid since the balance date has left the bank too; a paid bill is never due again.
  const billsSince = input.bills.filter((b) => b.status === "paid" && within(b.paidOn, balanceAsOf, asOf));
  const paymentsSinceCents = sum(paymentsSince.map((p) => p.amountCents));
  const advancesPaidSinceCents = sum(advancesSince.map((a) => a.amountCents));
  const settlementsPaidSinceCents = sum(settlementsSince.map((s) => s.netCents));
  const billsPaidSinceCents = sum(billsSince.map((b) => b.amountCents));
  const cashOnHandCents = sub(
    sum([cents(settings.bankBalanceCents, "bank balance"), paymentsSinceCents]),
    sum([advancesPaidSinceCents, settlementsPaidSinceCents, billsPaidSinceCents]),
  );

  const receivables: ReceivablesInput = {
    invoices: input.invoices,
    payments: input.payments,
    applications: input.applications,
    asOf,
  };
  // An invoice on a live factoring line is the partner's to collect: neither expected from the
  // customer by pay day, nor chased, nor offered for factoring again.
  const openInvoiceList = openInvoices(input).filter((o) => o.invoice.factored !== true);
  const profiles = profilesFor(openInvoiceList, receivables, asOf);
  const lines = lessUnappliedSince(
    expectedReceipts(openInvoiceList, profiles, asOf, payDay, limits.graceDays),
    paymentsSince,
    input.applications,
  );
  const expectedReceiptsCents = sum(lines.map((l) => l.expectedCents));

  const fuel = input.advances.filter((a) => a.status === "requested" || a.status === "approved");
  const fuelLoadsCents = sum(fuel.map((a) => a.amountCents));
  const due = billsDue(input.bills, payDay);
  const vendorBillsDueCents = sum(due.map((b) => b.amountCents));

  const gapCents = sub(
    sum([cashOnHandCents, expectedReceiptsCents]),
    sum([payRun.cents, fuelLoadsCents, vendorBillsDueCents]),
  );
  const figures: CashFigures = {
    bankBalanceCents: cents(settings.bankBalanceCents),
    balanceAsOf,
    paymentsSinceCents,
    advancesPaidSinceCents,
    settlementsPaidSinceCents,
    billsPaidSinceCents,
    cashOnHandCents,
    expectedReceiptsCents,
    payRunCents: payRun.cents,
    fuelLoadsCents,
    vendorBillsDueCents,
    gapCents,
  };

  const options: CashOption[] = [];
  if (gapCents < 0) {
    const shortCents = -gapCents;
    const invoices = new Map(input.invoices.map((i) => [i.id, i]));
    const factoring = factoringOption(lines, invoices, settings, period, asOf, shortCents, limits);
    if (factoring) options.push(factoring);
    const defer = billDeferOption(input.bills, payDay, shortCents);
    if (defer) options.push(defer);
    const unapplied = unappliedSince(paymentsSince, input.applications);
    const counted = { lines, unapplied, shortCents };
    options.push(...chaseOptions(openInvoiceList, profiles, asOf, limits.maxChaseCustomers, counted));
  }

  return {
    ok: true,
    asOf,
    payDay,
    periodId: period.id,
    period: { start: period.periodStart, end: period.periodEnd },
    payRunSource: payRun.source,
    figures,
    lines,
    options,
    sources: [
      { table: "settlement_periods", id: period.id },
      ...payRun.sources,
      ...fuel.map((a): SourceRef => ({ table: "advances", id: a.id })),
      ...due.map((b): SourceRef => ({ table: "vendor_bills", id: b.id })),
    ],
  };
}
