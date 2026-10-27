import { daysBetween } from "../time/local-date";
import { assertCents, cents, roundHalfUp, sub, sum } from "./money";
import {
  AGING_BUCKETS,
  assertDate,
  assertId,
  assertOneOf,
  compareText,
  INVOICE_SOURCES,
  INVOICE_STATUSES,
  InputError,
  type AgingBucket,
  type AgingTotals,
  type CustomerPaymentRecord,
  type Finding,
  type InvoiceRecord,
  type InvoiceStatusResult,
  type PaymentApplicationRecord,
  type PaymentLabel,
  type PaymentProfile,
  type ReceivablesAging,
  type ReceivablesInput,
  type SourceRef,
} from "./types";

// Receivables (design section 4.8): what customers owe the carrier and how late it is. Payments
// are recorded, never collected. The stored invoice status follows the applications; these
// functions are the one place that rule lives, for the seed, the app and the agent alike.

function checkInvoice(invoice: InvoiceRecord): InvoiceRecord {
  const id = assertId(invoice?.id, "invoice id");
  assertId(invoice.customerId, `invoice ${id} customerId`);
  assertOneOf(invoice.source, INVOICE_SOURCES, `invoice ${id} source`);
  assertOneOf(invoice.status, INVOICE_STATUSES, `invoice ${id} status`);
  assertCents(invoice.amountCents, `invoice ${id} amountCents`);
  assertDate(invoice.issuedOn, `invoice ${id} issuedOn`);
  assertDate(invoice.dueOn, `invoice ${id} dueOn`);
  if (invoice.source === "load" && invoice.loadId === null) {
    throw new InputError(`invoice ${id} is for a load but names none`);
  }
  return invoice;
}

function checkPayment(payment: CustomerPaymentRecord): CustomerPaymentRecord {
  const id = assertId(payment?.id, "payment id");
  assertId(payment.customerId, `payment ${id} customerId`);
  assertDate(payment.receivedOn, `payment ${id} receivedOn`);
  assertCents(payment.amountCents, `payment ${id} amountCents`);
  return payment;
}

function checkApplication(application: PaymentApplicationRecord): PaymentApplicationRecord {
  const id = assertId(application?.id, "application id");
  assertId(application.paymentId, `application ${id} paymentId`);
  assertId(application.invoiceId, `application ${id} invoiceId`);
  assertCents(application.amountCents, `application ${id} amountCents`);
  return application;
}

// 0 applied is open, under the amount partially paid, at or over it paid; what is past the
// amount is reported, never hidden. Void is a person's decision, never derived.
export function invoiceStatus(amountCents: number, appliedCents: number): InvoiceStatusResult {
  const amount = assertCents(amountCents, "invoice amountCents");
  if (amount === 0) throw new InputError("invoice amountCents is zero");
  const applied = cents(appliedCents, "applied cents");
  if (applied < 0) throw new InputError("applied cents is negative");
  if (applied === 0) return { status: "open", balanceCents: amount, overappliedCents: cents(0) };
  if (applied < amount) {
    return { status: "partially_paid", balanceCents: sub(amount, applied), overappliedCents: cents(0) };
  }
  return { status: "paid", balanceCents: cents(0), overappliedCents: sub(applied, amount) };
}

// Aging counts whole days from the due date to asOf, both tenant-local dates.
export function agingBucket(dueOn: string, asOf: string): AgingBucket {
  const late = daysBetween(assertDate(dueOn, "dueOn"), assertDate(asOf, "asOf"));
  if (late <= 0) return "current";
  if (late <= 30) return "1_30";
  if (late <= 60) return "31_60";
  if (late <= 90) return "61_90";
  return "over_90";
}

// Applied cents per invoice id, over every application given.
function appliedByInvoice(applications: readonly PaymentApplicationRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of applications.map(checkApplication)) {
    out.set(a.invoiceId, sum([out.get(a.invoiceId) ?? 0, a.amountCents]));
  }
  return out;
}

function emptyTotals(): AgingTotals {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [b, cents(0)])) as AgingTotals;
}

// Open balances by customer and bucket, over invoices that are not void and still owe money.
export function ageReceivables(input: ReceivablesInput): ReceivablesAging {
  const asOf = assertDate(input.asOf, "asOf");
  const applied = appliedByInvoice(input.applications);
  const byCustomer = new Map<string, AgingTotals>();
  const totals = emptyTotals();
  for (const invoice of input.invoices.map(checkInvoice)) {
    if (invoice.status === "void") continue;
    const { balanceCents } = invoiceStatus(invoice.amountCents, applied.get(invoice.id) ?? 0);
    if (balanceCents === 0) continue;
    const bucket = agingBucket(invoice.dueOn, asOf);
    const own = byCustomer.get(invoice.customerId) ?? emptyTotals();
    own[bucket] = sum([own[bucket], balanceCents]);
    byCustomer.set(invoice.customerId, own);
    totals[bucket] = sum([totals[bucket], balanceCents]);
  }
  return {
    byCustomer: [...byCustomer.entries()]
      .sort(([a], [b]) => compareText(a, b))
      .map(([customerId, buckets]) => ({ customerId, buckets })),
    totals,
  };
}

// The seventh check. For every invoice Y with more applied than its amount, each application on
// Y and its payment P: when the same customer has another invoice X still owing, whose amount
// equals P's exactly, P was most likely meant for X (payment_on_wrong_invoice, citing P, the
// application, Y and X, amount = the application). The part of Y's excess those findings do not
// explain is one invoice_overapplied finding for Y (amount = that remainder), citing P and the
// application of the last received payment on Y with no such X (it holds part of the excess),
// then Y. Nothing left, or no such application, gives no invoice_overapplied finding. Output
// order is fixed whatever order the records arrive in.
export function findPaymentOnWrongInvoice(input: ReceivablesInput): Finding[] {
  const invoices = input.invoices.map(checkInvoice);
  const payments = new Map(input.payments.map((p) => [checkPayment(p).id, p]));
  const applications = input.applications.map(checkApplication);
  const applied = appliedByInvoice(applications);
  const balanceOf = (i: InvoiceRecord) =>
    i.status === "void" ? 0 : invoiceStatus(i.amountCents, applied.get(i.id) ?? 0).balanceCents;
  const ordered = [...invoices].sort(
    (a, b) => compareText(a.invoiceNumber, b.invoiceNumber) || compareText(a.id, b.id),
  );
  const out: Finding[] = [];
  for (const y of ordered) {
    if (y.status === "void") continue;
    const { overappliedCents } = invoiceStatus(y.amountCents, applied.get(y.id) ?? 0);
    if (overappliedCents === 0) continue;
    const onY = applications
      .filter((a) => a.invoiceId === y.id)
      .sort((a, b) => compareText(a.paymentId, b.paymentId) || compareText(a.id, b.id));
    let unexplained: number = overappliedCents;
    let unmatched: SourceRef[] | null = null;
    let unmatchedOn = "";
    for (const application of onY) {
      const payment = payments.get(application.paymentId);
      if (!payment) throw new InputError(`application ${application.id} names no known payment`);
      const sources: SourceRef[] = [
        { table: "customer_payments", id: payment.id },
        { table: "payment_applications", id: application.id },
        { table: "invoices", id: y.id },
      ];
      const meant = ordered.find(
        (x) =>
          x.id !== y.id &&
          x.customerId === y.customerId &&
          x.amountCents === payment.amountCents &&
          balanceOf(x) > 0,
      );
      if (!meant) {
        // The last received; on the same day, the later in the fixed order above.
        if (unmatched === null || compareText(payment.receivedOn, unmatchedOn) >= 0) {
          unmatched = sources;
          unmatchedOn = payment.receivedOn;
        }
        continue;
      }
      unexplained = Math.max(0, sub(unexplained, application.amountCents));
      out.push({
        check: "payment_on_wrong_invoice",
        category: "payment_on_wrong_invoice",
        amountCents: application.amountCents,
        sources: [...sources, { table: "invoices", id: meant.id }],
      });
    }
    if (unexplained > 0 && unmatched !== null) {
      out.push({
        check: "payment_on_wrong_invoice",
        category: "invoice_overapplied",
        amountCents: cents(unexplained),
        sources: unmatched,
      });
    }
  }
  return out;
}

// How one customer pays (addendum B4), derived from its own invoices issued in the 180 days
// before asOf, void ones left out. A paid invoice was paid on the latest date of the payments
// applied to it; days late run from the due date to that day. late share is over paid invoices.
// reliable: at most 20% paid late and nothing over 30 days late, paid or open. repeat_late: at
// least half paid late, or two paid more than 30 days late, or two open more than 30 days past
// due. Anything else, and a customer with nothing paid yet, is mixed.
export function paymentProfile(
  customerId: string,
  input: ReceivablesInput,
  asOf: string,
): PaymentProfile {
  assertId(customerId, "customerId");
  const on = assertDate(asOf, "asOf");
  const payments = new Map(input.payments.map((p) => [checkPayment(p).id, p]));
  const applications = input.applications.map(checkApplication);
  const invoices = input.invoices
    .map(checkInvoice)
    .filter((i) => i.customerId === customerId && i.status !== "void")
    .filter((i) => {
      const age = daysBetween(i.issuedOn, on);
      return age >= 1 && age <= 180;
    });
  const late: number[] = [];
  let openPast30 = 0;
  for (const invoice of invoices) {
    const own = applications.filter((a) => a.invoiceId === invoice.id);
    const applied = sum(own.map((a) => a.amountCents));
    const { status } = invoiceStatus(invoice.amountCents, applied);
    if (status !== "paid") {
      if (daysBetween(invoice.dueOn, on) > 30) openPast30++;
      continue;
    }
    let paidOn = "";
    for (const a of own) {
      const payment = payments.get(a.paymentId);
      if (!payment) throw new InputError(`application ${a.id} names no known payment`);
      if (payment.receivedOn > paidOn) paidOn = payment.receivedOn;
    }
    late.push(daysBetween(invoice.dueOn, paidOn));
  }
  const paidCount = late.length;
  const lateCount = late.filter((d) => d > 0).length;
  const paidOver30Late = late.filter((d) => d > 30).length;
  const sorted = [...late].sort((a, b) => a - b);
  const mid = Math.floor(paidCount / 2);
  let medianDaysLate: number | null = null;
  if (paidCount > 0) {
    medianDaysLate = paidCount % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  const mostlyLate = paidCount > 0 && lateCount * 2 >= paidCount;
  const rarelyLate = paidCount > 0 && lateCount * 5 <= paidCount;
  let label: PaymentLabel = "mixed";
  if (mostlyLate || paidOver30Late >= 2 || openPast30 >= 2) label = "repeat_late";
  else if (rarelyLate && paidOver30Late === 0 && openPast30 === 0) label = "reliable";
  return {
    customerId,
    invoices: invoices.length,
    paidCount,
    medianDaysLate,
    lateShareBps: paidCount === 0 ? 0 : roundHalfUp(lateCount * 10000, paidCount),
    paidOver30Late,
    openPast30,
    label,
  };
}

export type DaysToPay = {
  customerId: string;
  // Invoices paid in the 180 days before asOf, void ones left out.
  paidCount: number;
  // Whole days from issue to paid, rounded half up (away from zero); null with none paid.
  meanDays: number | null;
  medianDays: number | null;
};

// a / b rounded half away from zero, on integers: roundHalfUp for the size, the sign put back.
function roundSigned(numerator: number, denominator: number): number {
  const size = roundHalfUp(Math.abs(numerator), denominator);
  return numerator < 0 ? -size : size;
}

// How long one customer takes to pay (profit brief), from its own invoices paid in the 180 days
// before asOf (0 to 180 days back, both tenant-local dates), void ones left out. Paid follows the
// same rule as paymentProfile: the applications cover the amount, and the paid date is the latest
// date of the payments applied. A payment received after asOf is not counted, so the answer as
// of a past day does not move when a later payment arrives. Days run from the issue date.
export function daysToPay(customerId: string, input: ReceivablesInput, asOf: string): DaysToPay {
  assertId(customerId, "customerId");
  const on = assertDate(asOf, "asOf");
  const payments = new Map(input.payments.map((p) => [checkPayment(p).id, p]));
  const applications = input.applications.map(checkApplication);
  const days: number[] = [];
  for (const invoice of input.invoices.map(checkInvoice)) {
    if (invoice.customerId !== customerId || invoice.status === "void") continue;
    let paidOn = "";
    let applied = 0;
    for (const a of applications) {
      if (a.invoiceId !== invoice.id) continue;
      const payment = payments.get(a.paymentId);
      if (!payment) throw new InputError(`application ${a.id} names no known payment`);
      if (payment.receivedOn > on) continue;
      applied = sum([applied, a.amountCents]);
      if (payment.receivedOn > paidOn) paidOn = payment.receivedOn;
    }
    if (applied === 0 || invoiceStatus(invoice.amountCents, applied).status !== "paid") continue;
    const age = daysBetween(paidOn, on);
    if (age < 0 || age > 180) continue;
    days.push(daysBetween(invoice.issuedOn, paidOn));
  }
  const paidCount = days.length;
  if (paidCount === 0) return { customerId, paidCount, meanDays: null, medianDays: null };
  const sorted = [...days].sort((a, b) => a - b);
  const mid = Math.floor(paidCount / 2);
  const medianDays =
    paidCount % 2 === 1 ? sorted[mid] : roundSigned(sum([sorted[mid - 1], sorted[mid]]), 2);
  return { customerId, paidCount, meanDays: roundSigned(sum(days), paidCount), medianDays };
}
