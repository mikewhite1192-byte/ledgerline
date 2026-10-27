import type { Queryable } from "../db";
import { readReceivablesInput, readTable } from "../data/read";
import {
  AGING_BUCKETS,
  ageReceivables,
  compareText,
  type AgingBucket,
  type AgingTotals,
} from "../rules-engine";
import { assertLocalDate, type LocalDate } from "../time/local-date";

// Receivables views over the readers: aging by customer (the rules engine's buckets) and payments
// received in a date range. Read only, numbers from the engine or SQL sums in integer cents. The
// agent's read tools and the pages share these, so this file imports no money or adapter code.

const sumBuckets = (b: AgingTotals): number => AGING_BUCKETS.reduce((s, k) => s + b[k], 0);

export type AgingRow = {
  customerId: string;
  code: string;
  name: string;
  buckets: AgingTotals;
  totalCents: number;
};

export type AgingView = {
  asOf: LocalDate;
  customers: AgingRow[];
  totals: AgingTotals;
  totalCents: number;
};

// minBucket keeps customers with a balance in that bucket or any later one; the totals cover the
// customers kept.
export async function readAging(
  q: Queryable,
  asOf: LocalDate,
  minBucket: AgingBucket = "current",
): Promise<AgingView> {
  const day = assertLocalDate(asOf, "aging date");
  const aging = ageReceivables(await readReceivablesInput(q, day));
  const names = await readTable(q, "customers");
  const byId = new Map(names.map((c) => [c.id, c]));
  const from = AGING_BUCKETS.indexOf(minBucket);
  const kept = aging.byCustomer.filter((c) => AGING_BUCKETS.slice(from).some((k) => c.buckets[k] > 0));
  const customers = kept
    .map((c) => {
      const named = byId.get(c.customerId);
      return {
        customerId: c.customerId,
        code: named?.code ?? "",
        name: named?.name ?? "",
        buckets: c.buckets,
        totalCents: sumBuckets(c.buckets),
      };
    })
    .sort((a, b) => compareText(a.code, b.code) || compareText(a.customerId, b.customerId));
  const totals = Object.fromEntries(
    AGING_BUCKETS.map((k) => [k, customers.reduce((s, c) => s + c.buckets[k], 0)]),
  ) as AgingTotals;
  return { asOf: day, customers, totals, totalCents: sumBuckets(totals) };
}

export type PaymentMethod = "check" | "ach" | "wire";

export type PaymentInRow = {
  id: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  receivedOn: LocalDate;
  method: PaymentMethod;
  paymentRef: string;
  amountCents: number;
  appliedCents: number;
  unappliedCents: number;
  posted: boolean;
  applications: { id: string; invoiceId: string; invoiceNumber: string; amountCents: number }[];
};

export type PaymentsView = {
  from: LocalDate;
  to: LocalDate;
  payments: PaymentInRow[];
  totalsByMethod: Record<PaymentMethod, number>;
  totalCents: number;
};

// Payments received from one date to another, both included, oldest first. The memo is left out:
// it is free text a person typed, and nothing here needs it.
export async function readPaymentsBetween(
  q: Queryable,
  from: LocalDate,
  to: LocalDate,
): Promise<PaymentsView> {
  const start = assertLocalDate(from, "payments from");
  const end = assertLocalDate(to, "payments to");
  if (end < start) throw new RangeError("payments range ends before it starts");
  const customers = new Map((await readTable(q, "customers")).map((c) => [c.id, c]));
  const invoiceNumbers = new Map((await readTable(q, "invoices")).map((i) => [i.id, i.invoice_number]));
  const rows = (await readTable(q, "customer_payments"))
    .filter((p) => p.received_on >= start && p.received_on <= end)
    .sort(
      (a, b) =>
        compareText(a.received_on, b.received_on) ||
        compareText(a.payment_ref, b.payment_ref) ||
        compareText(a.id, b.id),
    );
  const wanted = new Set(rows.map((p) => p.id));
  const byPayment = new Map<string, PaymentInRow["applications"]>();
  for (const a of await readTable(q, "payment_applications")) {
    if (!wanted.has(a.payment_id)) continue;
    const list = byPayment.get(a.payment_id) ?? [];
    list.push({
      id: a.id,
      invoiceId: a.invoice_id,
      invoiceNumber: invoiceNumbers.get(a.invoice_id) ?? "",
      amountCents: Number(a.amount_cents),
    });
    byPayment.set(a.payment_id, list);
  }
  for (const list of byPayment.values()) {
    list.sort((x, y) => compareText(x.invoiceNumber, y.invoiceNumber) || compareText(x.id, y.id));
  }
  const totalsByMethod: Record<PaymentMethod, number> = { check: 0, ach: 0, wire: 0 };
  const payments = rows.map((r) => {
    const applications = byPayment.get(r.id) ?? [];
    const amountCents = Number(r.amount_cents);
    const appliedCents = applications.reduce((s, a) => s + a.amountCents, 0);
    totalsByMethod[r.method] += amountCents;
    return {
      id: r.id,
      customerId: r.customer_id,
      customerCode: customers.get(r.customer_id)?.code ?? "",
      customerName: customers.get(r.customer_id)?.name ?? "",
      receivedOn: r.received_on,
      method: r.method,
      paymentRef: r.payment_ref,
      amountCents,
      appliedCents,
      unappliedCents: amountCents - appliedCents,
      posted: r.qbo_id !== null,
      applications,
    };
  });
  return {
    from: start,
    to: end,
    payments,
    totalsByMethod,
    totalCents: payments.reduce((s, p) => s + p.amountCents, 0),
  };
}
