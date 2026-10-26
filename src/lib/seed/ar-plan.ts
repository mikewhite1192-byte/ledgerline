import type {
  CustomerPaymentRow,
  CustomerRow,
  InvoiceRow,
  PaymentApplicationRow,
} from "../data/rows";
import {
  compareText,
  invoiceAmount,
  invoiceStatus,
  roundHalfUp,
  type LoadRecord,
} from "../rules-engine";
import { addDays, daysBetween, type LocalDate } from "../time/local-date";
import type { Rng } from "./prng";

// Receivables for one carrier (design section 4.8): what its customers owe and what they paid.
// Two kinds of invoice: one per settled-week load that has a rate, issued the day after delivery,
// and about ninety "opening" invoices with no load, the receivables the carrier carries into the
// app, spread over the five months before the window so every aging bucket holds some. Payments
// are recorded checks, ACH and wires; most invoices are paid on time, some late, a few in part,
// and some payments settle two or three invoices at once. One payment is planted on the wrong
// invoice (the seventh problem). Every date stays on or before anchor - 1.

export const OPENING_INVOICE_COUNT = 90;

// Opening invoices left open on purpose, per past-due bucket, so no bucket is ever empty: the
// days past due as of the anchor, and how many. The current bucket is filled from the window.
const PAST_DUE: readonly [number, number][] = [
  [1, 30],
  [31, 60],
  [61, 90],
  [91, Number.MAX_SAFE_INTEGER],
];
const OPEN_PER_BUCKET = 4;
// The least each bucket holds: the counts and money the plan check asks for.
const CURRENT_MIN_INVOICES = 3;
const CURRENT_MIN_CENTS = 500000;

// The planted payment on the wrong invoice: P was for X but was applied in full to Y.
export type WrongInvoicePlant = {
  customerId: string;
  paymentId: string;
  applicationId: string;
  appliedToInvoiceId: string;
  meantForInvoiceId: string;
};

export type ReceivablesPlan = {
  invoices: InvoiceRow[];
  payments: CustomerPaymentRow[];
  applications: PaymentApplicationRow[];
  wrongInvoice: WrongInvoicePlant;
};

type Outcome = "on_time" | "late_1_30" | "late_31_60" | "late_61_90" | "late_91" | "open";

// Lateness classes in order; a class that cannot happen by anchor - 1 falls to the next one.
const LATE: readonly [Outcome, number, number][] = [
  ["late_1_30", 1, 30],
  ["late_31_60", 31, 60],
  ["late_61_90", 61, 90],
  ["late_91", 91, Number.MAX_SAFE_INTEGER],
];

type Draft = {
  invoice: Omit<InvoiceRow, "invoice_number" | "status" | "paid_on">;
  order: number;
  // Received date and amount when a payment covers it; partial means part of the amount.
  receivedOn: LocalDate | null;
  partialCents: number | null;
};

export type ReceivablesArgs = {
  slug: string;
  prefix: string;
  anchor: LocalDate;
  rng: Rng;
  newId: () => string;
  customers: readonly CustomerRow[];
  // The settled weeks' loads, as records; the ones with a rate and a delivery are invoiced.
  windowLoads: readonly LoadRecord[];
};

export function buildReceivables(args: ReceivablesArgs): ReceivablesPlan {
  const { slug, prefix, anchor, rng, newId, customers } = args;
  const lastDay = addDays(anchor, -1);
  const terms = new Map(customers.map((c) => [c.id, c.terms_days]));
  const termsOf = (customerId: string) => {
    const t = terms.get(customerId);
    if (t === undefined) throw new Error("invoice for an unknown customer");
    return t;
  };
  const drafts: Draft[] = [];
  const between = (from: LocalDate, to: LocalDate) =>
    addDays(from, rng.int(0, daysBetween(from, to)));
  const draft = (
    source: InvoiceRow["source"],
    loadId: string | null,
    customerId: string,
    amount: number,
    issuedOn: LocalDate,
  ): Draft => {
    const d: Draft = {
      invoice: {
        id: newId(),
        source,
        load_id: loadId,
        customer_id: customerId,
        amount_cents: amount,
        issued_on: issuedOn,
        due_on: addDays(issuedOn, termsOf(customerId)),
        qbo_id: null,
      },
      order: drafts.length,
      receivedOn: null,
      partialCents: null,
    };
    drafts.push(d);
    return d;
  };
  const latest = (a: LocalDate, b: LocalDate) => (a < b ? b : a);
  const earliest = (a: LocalDate, b: LocalDate) => (a < b ? a : b);
  const settle = (d: Draft, outcome: Outcome) => {
    const { issued_on: issued, due_on: due } = d.invoice;
    if (outcome === "open") return;
    if (outcome === "on_time") {
      d.receivedOn = between(issued, earliest(due, lastDay));
    } else {
      let i = LATE.findIndex(([o]) => o === outcome);
      for (; i < LATE.length; i++) {
        const [, lo, hi] = LATE[i];
        if (addDays(due, lo) <= lastDay) {
          d.receivedOn = addDays(due, rng.int(lo, Math.min(hi, daysBetween(due, lastDay))));
          break;
        }
      }
      if (d.receivedOn === null) return;
    }
    if (rng.chance(6, 100)) {
      d.partialCents = roundHalfUp(d.invoice.amount_cents * rng.int(40, 70), 100);
    }
  };

  // (1) The settled weeks' loads.
  for (const load of args.windowLoads) {
    const billed = invoiceAmount(load);
    if (!billed.ok || load.deliveredOn === null || load.customerId === null) continue;
    const issued = addDays(load.deliveredOn, 1);
    const d = draft("load", load.id, load.customerId, billed.amountCents, issued);
    settle(d, rng.chance(60, 100) ? "on_time" : "open");
  }
  // The newest of them not yet due stay open until the current bucket holds enough.
  const notDue = drafts
    .filter((d) => d.invoice.due_on >= anchor)
    .sort((a, b) => compareText(b.invoice.issued_on, a.invoice.issued_on) || a.order - b.order);
  let current = notDue.filter((d) => d.receivedOn === null);
  for (const d of notDue) {
    const held = current.reduce((n, x) => n + x.invoice.amount_cents, 0);
    if (current.length >= CURRENT_MIN_INVOICES && held >= CURRENT_MIN_CENTS) break;
    if (d.receivedOn === null) continue;
    d.receivedOn = null;
    d.partialCents = null;
    current = [...current, d];
  }

  // (2) Opening receivables, with no load: first the ones left open in each past-due bucket,
  // issued so they are that many days past due on the anchor, then the rest at random.
  for (const [lo, hi] of PAST_DUE) {
    for (let k = 0; k < OPEN_PER_BUCKET; k++) {
      const customer = rng.pick(customers);
      const terms = customer.terms_days;
      const late = rng.int(Math.max(lo, 29 - terms), Math.min(hi, 154 - terms));
      const issued = addDays(anchor, -late - terms);
      draft("opening", null, customer.id, rng.int(1500, 4800) * 100, issued);
    }
  }
  for (let k = PAST_DUE.length * OPEN_PER_BUCKET; k < OPENING_INVOICE_COUNT; k++) {
    const customer = rng.pick(customers);
    const amount = rng.int(900, 4800) * 100;
    const issued = between(addDays(anchor, -154), addDays(anchor, -29));
    const d = draft("opening", null, customer.id, amount, issued);
    settle(
      d,
      rng.weighted<Outcome>([
        ["on_time", 55],
        ["late_1_30", 14],
        ["late_31_60", 8],
        ["late_61_90", 5],
        ["late_91", 4],
        ["open", 14],
      ]),
    );
  }

  // Payments: one per paid invoice, except that a third of the time a customer's full payment
  // also covers the next one or two of theirs received within ten days, on the latest date.
  type PaymentDraft = {
    row: Omit<CustomerPaymentRow, "payment_ref">;
    covers: [Draft, number][];
    ref?: string;
  };
  const paymentDrafts: PaymentDraft[] = [];
  const method = () =>
    rng.weighted<CustomerPaymentRow["method"]>([
      ["check", 50],
      ["ach", 40],
      ["wire", 10],
    ]);
  const pay = (
    customerId: string,
    receivedOn: LocalDate,
    covers: [Draft, number][],
    ref?: string,
  ) => {
    const amount = covers.reduce((n, [, a]) => n + a, 0);
    const p: PaymentDraft = {
      row: {
        id: newId(),
        customer_id: customerId,
        received_on: receivedOn,
        amount_cents: amount,
        method: ref ? "check" : method(),
        source: "seed",
        memo: null,
        qbo_id: null,
      },
      covers,
      ref,
    };
    paymentDrafts.push(p);
    return p;
  };
  for (const customer of customers) {
    const paid = drafts
      .filter((d) => d.invoice.customer_id === customer.id && d.receivedOn !== null)
      .sort((a, b) => compareText(a.receivedOn!, b.receivedOn!) || a.order - b.order);
    for (let i = 0; i < paid.length; ) {
      const first = paid[i];
      if (first.partialCents !== null) {
        pay(customer.id, first.receivedOn!, [[first, first.partialCents]]);
        i++;
        continue;
      }
      const group = [first];
      if (rng.chance(1, 3)) {
        const want = rng.int(1, 2);
        for (let j = i + 1; j < paid.length && group.length <= want; j++) {
          const next = paid[j];
          if (next.partialCents !== null) break;
          if (daysBetween(first.receivedOn!, next.receivedOn!) > 10) break;
          group.push(next);
        }
      }
      const on = group.reduce((m, d) => latest(m, d.receivedOn!), first.receivedOn!);
      for (const d of group) d.receivedOn = on;
      pay(customer.id, on, group.map((d) => [d, d.invoice.amount_cents] as [Draft, number]));
      i += group.length;
    }
  }

  // (3) The planted pair. C: the customer on 30 days or less with the most opening invoices. X's
  // amount is unique among C's invoices and payments, so the check can point at X alone.
  const openingCount = new Map<string, number>();
  for (const d of drafts) {
    if (d.invoice.source === "opening") {
      const id = d.invoice.customer_id;
      openingCount.set(id, (openingCount.get(id) ?? 0) + 1);
    }
  }
  const c = customers
    .filter((x) => x.terms_days <= 30)
    .sort(
      (a, b) =>
        (openingCount.get(b.id) ?? 0) - (openingCount.get(a.id) ?? 0) ||
        compareText(a.code, b.code),
    )[0];
  if (!c) throw new Error("no customer on 30-day terms for the planted payment");
  const taken = new Set([
    ...drafts.filter((d) => d.invoice.customer_id === c.id).map((d) => d.invoice.amount_cents),
    ...paymentDrafts.filter((q) => q.row.customer_id === c.id).map((q) => q.row.amount_cents),
  ]);
  let xAmount = rng.int(2000, 3500) * 100;
  while (taken.has(xAmount)) xAmount += 100;
  const yAmount = roundHalfUp(xAmount * 5500, 10000);
  const y = draft("opening", null, c.id, yAmount, addDays(anchor, -150));
  const x = draft("opening", null, c.id, xAmount, addDays(anchor, -140));
  // P: X's amount, three days before X was due, applied in full to Y.
  const p = pay(c.id, addDays(x.invoice.due_on, -3), [[y, xAmount]], `${slug}-pay-wrong-inv`);

  // Numbers and refs in date order; statuses from the applications, by the engine's rule.
  const byIssued = [...drafts].sort(
    (a, b) => compareText(a.invoice.issued_on, b.invoice.issued_on) || a.order - b.order,
  );
  const numberOf = new Map(byIssued.map((d, i) => [d, `${prefix}-INV-${10001 + i}`]));
  const byReceived = paymentDrafts
    .map((q, i) => [q, i] as const)
    .sort(([a, i], [b, j]) => compareText(a.row.received_on, b.row.received_on) || i - j);
  let n = 0;
  const payments: CustomerPaymentRow[] = byReceived.map(([q]) => ({
    ...q.row,
    payment_ref: q.ref ?? `${slug}-pay-${++n}`,
  }));
  const applications: PaymentApplicationRow[] = [];
  const applied = new Map<Draft, { cents: number; on: LocalDate }>();
  let wrongApplicationId = "";
  for (const [q] of byReceived) {
    for (const [d, amount] of q.covers) {
      const id = newId();
      if (q === p) wrongApplicationId = id;
      applications.push({
        id,
        payment_id: q.row.id,
        invoice_id: d.invoice.id,
        amount_cents: amount,
      });
      const before = applied.get(d);
      applied.set(d, {
        cents: (before?.cents ?? 0) + amount,
        on: before ? latest(before.on, q.row.received_on) : q.row.received_on,
      });
    }
  }
  const invoices: InvoiceRow[] = byIssued.map((d) => {
    const a = applied.get(d);
    const { status } = invoiceStatus(d.invoice.amount_cents, a?.cents ?? 0);
    return {
      ...d.invoice,
      invoice_number: numberOf.get(d)!,
      status,
      paid_on: status === "paid" ? a!.on : null,
    };
  });
  return {
    invoices,
    payments,
    applications,
    wrongInvoice: {
      customerId: c.id,
      paymentId: p.row.id,
      applicationId: wrongApplicationId,
      appliedToInvoiceId: y.invoice.id,
      meantForInvoiceId: x.invoice.id,
    },
  };
}
