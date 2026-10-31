import { customerOf, loadStopsOf } from "../data/records";
import type {
  CustomerPaymentRow,
  CustomerRow,
  InvoiceRow,
  LoadAccessorialRow,
  LoadRow,
  PaymentApplicationRow,
} from "../data/rows";
import { detentionCents, invoiceAmount, invoiceStatus, type LoadRecord } from "../rules-engine";
import type { LocalDate } from "../time/local-date";
import { Rng } from "./prng";

// The billed detention a customer short-paid. The first detention plant's load waited a day at
// delivery; the carrier billed that wait on the load, and the customer paid everything on the
// invoice except the detention line, with a remittance note. Every amount is the engine's: the
// charge is the load's detention from its stop times, the invoice is the load's invoice amount,
// and the payment is that invoice less the charge. The rows take their ids from their own
// stream, so no other id in the plan moves.

export type DisputedDetention = {
  loadId: string;
  accessorialId: string;
  invoiceId: string;
  paymentId: string;
  applicationId: string;
};

export const SHORT_PAY_MEMO = "Detention not approved, see remittance";

export function disputedIds(seed: string): () => string {
  const rng = new Rng(`${seed}:acme`);
  return () => rng.uuid();
}

// The detention charge for the load, at the engine's amount for its stop times.
export function billDetention(
  load: LoadRow,
  customer: CustomerRow,
  newId: () => string,
): LoadAccessorialRow {
  const cents = detentionCents(loadStopsOf(load), customerOf(customer));
  if (cents === null || cents <= 0) throw new Error("the disputed load earned no detention");
  return {
    id: newId(),
    load_id: load.id,
    kind: "detention",
    seq: 1,
    amount_cents: cents,
    paid_by_driver: false,
    description: "Detention at receiver",
  };
}

// The customer's check for everything but the detention, applied to the load's invoice. The
// invoice must be the engine's amount for the load and still unpaid; its status then follows
// the engine's rule, partly paid with exactly the detention owed.
export function shortPay(args: {
  prefix: string;
  load: LoadRecord;
  charge: LoadAccessorialRow;
  invoices: InvoiceRow[];
  payments: CustomerPaymentRow[];
  applications: PaymentApplicationRow[];
  receivedOn: LocalDate;
  newId: () => string;
}): DisputedDetention {
  const { load, charge } = args;
  const invoice = args.invoices.find((i) => i.load_id === load.id);
  if (!invoice || invoice.status !== "open") throw new Error("the disputed load has no open invoice");
  const billed = invoiceAmount(load);
  if (!billed.ok || billed.amountCents !== invoice.amount_cents) {
    throw new Error("the disputed invoice is not the load's invoice amount");
  }
  if (!billed.lines.some((l) => l.sources.some((s) => s.id === charge.id))) {
    throw new Error("the disputed invoice does not bill the detention");
  }
  if (args.receivedOn < invoice.issued_on) throw new Error("the short payment predates its invoice");
  const paidCents = billed.amountCents - charge.amount_cents;
  const payment: CustomerPaymentRow = {
    id: args.newId(),
    customer_id: invoice.customer_id,
    received_on: args.receivedOn,
    amount_cents: paidCents,
    method: "check",
    source: "seed",
    memo: SHORT_PAY_MEMO,
    qbo_id: null,
    payment_ref: `${args.prefix}-PAY-SHORT`,
  };
  const application: PaymentApplicationRow = {
    id: args.newId(),
    payment_id: payment.id,
    invoice_id: invoice.id,
    amount_cents: paidCents,
  };
  const status = invoiceStatus(invoice.amount_cents, paidCents);
  if (status.status !== "partially_paid" || status.balanceCents !== charge.amount_cents) {
    throw new Error("the short payment does not leave exactly the detention owed");
  }
  invoice.status = status.status;
  args.payments.push(payment);
  args.applications.push(application);
  return {
    loadId: load.id,
    accessorialId: charge.id,
    invoiceId: invoice.id,
    paymentId: payment.id,
    applicationId: application.id,
  };
}
