import type { Queryable } from "../db";
import { loadsOf } from "../data/records";
import { readInvoiceQueue, readRowsWhereId, readTable } from "../data/read";
import { readBySubject } from "../money/read";
import type { MoneyActionState } from "../money/types";
import {
  agingBucket,
  compareText,
  invoiceAmount,
  invoiceStatus,
  type AgingBucket,
  type AgingTotals,
} from "../rules-engine";
import type { LocalDate } from "../time/local-date";
import { flags } from "../../config/flags";
import { LINE_WORDS } from "./execute";
import type { QueueReason } from "./labels";
import { readAging } from "./aging";
import { splitInvoiceQueue } from "./queue";

// What the invoice and receivables pages show, read inside the request's tenant transaction.
// Read only: every number is a stored amount, a SQL row or the rules engine's answer, in cents.
// A missing record is null (the page shows not found); a failed read throws (the page shows the
// error, never an empty list).

export type LedgerRow = {
  id: string;
  attempt: number;
  state: MoneyActionState;
  failureCategory: string | null;
  amountCents: number;
  createdAt: string;
};

export type InvoiceListRow = {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  loadId: string | null;
  status: string;
  amountCents: number;
  balanceCents: number;
  issuedOn: string;
  dueOn: string;
  bucket: AgingBucket | null;
  posted: boolean;
};

export type QueueItemRow = {
  loadId: string;
  loadNumber: string;
  customerName: string;
  deliveredOn: string | null;
  amountCents: number | null;
  reason: QueueReason | null;
};

function ledgerRows(actions: Awaited<ReturnType<typeof readBySubject>>, kind: string): LedgerRow[] {
  return actions
    .filter((a) => a.kind === kind)
    .map((a) => ({
      id: a.id,
      attempt: a.attempt,
      state: a.state,
      failureCategory: a.failureCategory,
      amountCents: a.amountCents,
      createdAt: a.createdAt,
    }));
}

function appliedByInvoice(apps: readonly { invoice_id: string; amount_cents: number | string }[]) {
  const out = new Map<string, number>();
  for (const a of apps) out.set(a.invoice_id, (out.get(a.invoice_id) ?? 0) + Number(a.amount_cents));
  return out;
}

// Balance and bucket for one invoice: a void or paid invoice owes nothing and has no bucket.
function standing(
  inv: { amount_cents: number | string; status: string; due_on: string },
  applied: number,
  asOf: LocalDate,
): { balanceCents: number; bucket: AgingBucket | null } {
  if (inv.status === "void") return { balanceCents: 0, bucket: null };
  const { balanceCents } = invoiceStatus(Number(inv.amount_cents), applied);
  return { balanceCents, bucket: balanceCents > 0 ? agingBucket(inv.due_on, asOf) : null };
}

// Every invoice, newest issued first, with what it still owes as of the carrier's today.
export async function readInvoiceList(q: Queryable, asOf: LocalDate): Promise<InvoiceListRow[]> {
  const customers = new Map((await readTable(q, "customers")).map((c) => [c.id, c.name]));
  const applied = appliedByInvoice(await readTable(q, "payment_applications"));
  return (await readTable(q, "invoices"))
    .map((i) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      customerId: i.customer_id,
      customerName: customers.get(i.customer_id) ?? "",
      loadId: i.load_id,
      status: i.status,
      amountCents: Number(i.amount_cents),
      issuedOn: i.issued_on,
      dueOn: i.due_on,
      posted: i.qbo_id !== null,
      ...standing(i, applied.get(i.id) ?? 0, asOf),
    }))
    .sort((a, b) => compareText(b.issuedOn, a.issuedOn) || compareText(b.invoiceNumber, a.invoiceNumber));
}

// The queue split for the page: loads the engine can invoice and loads it refuses, with why.
export async function readQueueView(
  q: Queryable,
): Promise<{ invoiceable: QueueItemRow[]; exceptions: QueueItemRow[] }> {
  const { loads, customers } = await readInvoiceQueue(q, flags.invoicesStart);
  const byId = new Map(customers.map((c) => [c.id, c.name]));
  const names = { get: (id: string | null) => (id === null ? undefined : byId.get(id)) };
  const queue = splitInvoiceQueue(loads, customers);
  return {
    invoiceable: queue.invoiceable.map((i) => ({
      loadId: i.load.id,
      loadNumber: i.load.loadNumber,
      customerName: names.get(i.load.customerId) ?? "",
      deliveredOn: i.load.deliveredOn,
      amountCents: i.amountCents,
      reason: null,
    })),
    exceptions: queue.exceptions.map((e) => ({
      loadId: e.load.id,
      loadNumber: e.load.loadNumber,
      customerName: names.get(e.load.customerId) ?? "",
      deliveredOn: e.load.deliveredOn,
      amountCents: null,
      reason: e.reason,
    })),
  };
}

export type ApplicationRow = {
  id: string;
  paymentId: string;
  paymentRef: string;
  invoiceId: string;
  invoiceNumber: string;
  receivedOn: string;
  amountCents: number;
};

export type InvoiceRecordView = InvoiceListRow & {
  source: string;
  loadNumber: string | null;
  qboTail: string | null;
  lines: { kind: string; label: string; amountCents: number }[] | null;
  applications: ApplicationRow[];
  ledger: LedgerRow[];
};

const tail = (id: string | null): string | null => (id === null ? null : id.slice(-4));

export async function readInvoiceRecord(
  q: Queryable,
  id: string,
  asOf: LocalDate,
): Promise<InvoiceRecordView | null> {
  const [inv] = await readRowsWhereId(q, "invoices", "id", id);
  if (!inv) return null;
  const [customer] = await readRowsWhereId(q, "customers", "id", inv.customer_id);
  const apps = await readRowsWhereId(q, "payment_applications", "invoice_id", id);
  const payments = new Map(
    (await readTable(q, "customer_payments")).map((p) => [p.id, { ref: p.payment_ref, on: p.received_on }]),
  );
  let loadNumber: string | null = null;
  let lines: InvoiceRecordView["lines"] = null;
  if (inv.load_id) {
    const loadRows = await readRowsWhereId(q, "loads", "id", inv.load_id);
    if (loadRows.length === 1) {
      const miles = await readRowsWhereId(q, "load_state_miles", "load_id", inv.load_id);
      const extras = await readRowsWhereId(q, "load_accessorials", "load_id", inv.load_id);
      const [load] = loadsOf(loadRows, miles, extras);
      loadNumber = load.loadNumber;
      // The engine's lines for the load now; shown only when they still add up to the invoice.
      const engine = invoiceAmount(load);
      if (engine.ok && engine.amountCents === Number(inv.amount_cents)) {
        lines = engine.lines.map((l) => ({ kind: l.kind, label: LINE_WORDS[l.kind], amountCents: l.amountCents }));
      }
    }
  }
  const applied = apps.reduce((s, a) => s + Number(a.amount_cents), 0);
  return {
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    customerId: inv.customer_id,
    customerName: customer?.name ?? "",
    loadId: inv.load_id,
    status: inv.status,
    amountCents: Number(inv.amount_cents),
    issuedOn: inv.issued_on,
    dueOn: inv.due_on,
    posted: inv.qbo_id !== null,
    ...standing(inv, applied, asOf),
    source: inv.source,
    loadNumber,
    qboTail: tail(inv.qbo_id),
    lines,
    applications: apps
      .map((a) => ({
        id: a.id,
        paymentId: a.payment_id,
        paymentRef: payments.get(a.payment_id)?.ref ?? "",
        invoiceId: a.invoice_id,
        invoiceNumber: inv.invoice_number,
        receivedOn: payments.get(a.payment_id)?.on ?? "",
        amountCents: Number(a.amount_cents),
      }))
      .sort((a, b) => compareText(a.receivedOn, b.receivedOn) || compareText(a.id, b.id)),
    ledger: ledgerRows(await readBySubject(q, "invoices", id), "invoice"),
  };
}

export type PaymentRecordView = {
  id: string;
  customerId: string;
  customerName: string;
  receivedOn: string;
  method: string;
  paymentRef: string;
  source: string;
  amountCents: number;
  appliedCents: number;
  creditCents: number;
  posted: boolean;
  qboTail: string | null;
  // Posting waits until every invoice the payment applies to is in QuickBooks.
  invoicesPosted: boolean;
  applications: ApplicationRow[];
  ledger: LedgerRow[];
};

export async function readPaymentRecord(q: Queryable, id: string): Promise<PaymentRecordView | null> {
  const [p] = await readRowsWhereId(q, "customer_payments", "id", id);
  if (!p) return null;
  const [customer] = await readRowsWhereId(q, "customers", "id", p.customer_id);
  const invoices = new Map((await readTable(q, "invoices")).map((i) => [i.id, i]));
  const apps = (await readRowsWhereId(q, "payment_applications", "payment_id", id))
    .map((a) => ({
      id: a.id,
      paymentId: a.payment_id,
      paymentRef: p.payment_ref,
      invoiceId: a.invoice_id,
      invoiceNumber: invoices.get(a.invoice_id)?.invoice_number ?? "",
      receivedOn: p.received_on,
      amountCents: Number(a.amount_cents),
    }))
    .sort((a, b) => compareText(a.invoiceNumber, b.invoiceNumber) || compareText(a.id, b.id));
  const amountCents = Number(p.amount_cents);
  const appliedCents = apps.reduce((s, a) => s + a.amountCents, 0);
  return {
    id: p.id,
    customerId: p.customer_id,
    customerName: customer?.name ?? "",
    receivedOn: p.received_on,
    method: p.method,
    paymentRef: p.payment_ref,
    source: p.source,
    amountCents,
    appliedCents,
    creditCents: amountCents - appliedCents,
    posted: p.qbo_id !== null,
    qboTail: tail(p.qbo_id),
    invoicesPosted: apps.every((a) => (invoices.get(a.invoiceId)?.qbo_id ?? null) !== null),
    applications: apps,
    ledger: ledgerRows(await readBySubject(q, "customer_payments", id), "customer_payment"),
  };
}

export type CustomerRecordView = {
  id: string;
  code: string;
  name: string;
  termsDays: number;
  invoices: InvoiceListRow[];
  payments: { id: string; receivedOn: string; method: string; paymentRef: string; amountCents: number; creditCents: number }[];
  creditCents: number;
  aging: AgingTotals | null;
  agingTotalCents: number;
};

export async function readCustomerRecord(
  q: Queryable,
  id: string,
  asOf: LocalDate,
): Promise<CustomerRecordView | null> {
  const [c] = await readRowsWhereId(q, "customers", "id", id);
  if (!c) return null;
  const invoices = (await readInvoiceList(q, asOf)).filter((i) => i.customerId === id);
  const allApps = await readTable(q, "payment_applications");
  const payments = (await readRowsWhereId(q, "customer_payments", "customer_id", id))
    .map((p) => {
      const applied = allApps
        .filter((a) => a.payment_id === p.id)
        .reduce((s, a) => s + Number(a.amount_cents), 0);
      const amountCents = Number(p.amount_cents);
      return {
        id: p.id,
        receivedOn: p.received_on,
        method: p.method,
        paymentRef: p.payment_ref,
        amountCents,
        creditCents: amountCents - applied,
      };
    })
    .sort((a, b) => compareText(b.receivedOn, a.receivedOn) || compareText(a.id, b.id));
  const aging = (await readAging(q, asOf)).customers.find((r) => r.customerId === id) ?? null;
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    termsDays: c.terms_days,
    invoices,
    payments,
    creditCents: payments.reduce((s, p) => s + p.creditCents, 0),
    aging: aging?.buckets ?? null,
    agingTotalCents: aging?.totalCents ?? 0,
  };
}

export type LoadRecordView = {
  id: string;
  loadNumber: string;
  status: string;
  customerId: string;
  customerName: string;
  lane: string;
  pickupOn: string;
  deliveredOn: string | null;
  loadedMiles: number;
  emptyMiles: number;
  linehaulCents: number | null;
  fuelSurchargeCents: number;
  stateMiles: { state: string; miles: number }[];
  accessorials: { id: string; kind: string; amountCents: number }[];
  invoice: { id: string; invoiceNumber: string; status: string } | null;
  engine:
    | { ok: true; amountCents: number; lines: { kind: string; label: string; amountCents: number }[] }
    | { ok: false; reason: QueueReason };
};

export async function readLoadRecord(q: Queryable, id: string): Promise<LoadRecordView | null> {
  const loadRows = await readRowsWhereId(q, "loads", "id", id);
  if (loadRows.length !== 1) return null;
  const row = loadRows[0];
  const miles = await readRowsWhereId(q, "load_state_miles", "load_id", id);
  const extras = await readRowsWhereId(q, "load_accessorials", "load_id", id);
  const [load] = loadsOf(loadRows, miles, extras);
  const [customer] = await readRowsWhereId(q, "customers", "id", row.customer_id);
  const [invoice] = await readRowsWhereId(q, "invoices", "load_id", id);
  const engine = invoiceAmount(load);
  return {
    id: row.id,
    loadNumber: row.load_number,
    status: row.status,
    customerId: row.customer_id,
    customerName: customer?.name ?? "",
    lane: `${row.origin_city}, ${row.origin_state} to ${row.dest_city}, ${row.dest_state}`,
    pickupOn: row.pickup_on,
    deliveredOn: row.delivered_on,
    loadedMiles: Number(row.loaded_miles),
    emptyMiles: Number(row.empty_miles),
    linehaulCents: row.linehaul_cents === null ? null : Number(row.linehaul_cents),
    fuelSurchargeCents: Number(row.fuel_surcharge_cents),
    stateMiles: miles
      .map((m) => ({ state: m.state, miles: Number(m.miles) }))
      .sort((a, b) => compareText(a.state, b.state)),
    accessorials: extras.map((a) => ({ id: a.id, kind: a.kind, amountCents: Number(a.amount_cents) })),
    invoice: invoice ? { id: invoice.id, invoiceNumber: invoice.invoice_number, status: invoice.status } : null,
    engine: engine.ok
      ? {
          ok: true,
          amountCents: engine.amountCents,
          lines: engine.lines.map((l) => ({ kind: l.kind, label: LINE_WORDS[l.kind], amountCents: l.amountCents })),
        }
      : { ok: false, reason: engine.reason },
  };
}

export type PaymentFormCustomer = {
  id: string;
  code: string;
  name: string;
  invoices: { id: string; invoiceNumber: string; dueOn: string; balanceCents: number }[];
};

// The customers and each one's open invoices, oldest due first, for the payment form to prefill.
export async function readPaymentForm(q: Queryable, asOf: LocalDate): Promise<PaymentFormCustomer[]> {
  const invoices = (await readInvoiceList(q, asOf)).filter(
    (i) => (i.status === "open" || i.status === "partially_paid") && i.balanceCents > 0,
  );
  return (await readTable(q, "customers"))
    .map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      invoices: invoices
        .filter((i) => i.customerId === c.id)
        .sort((a, b) => compareText(a.dueOn, b.dueOn) || compareText(a.invoiceNumber, b.invoiceNumber))
        .map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, dueOn: i.dueOn, balanceCents: i.balanceCents })),
    }))
    .sort((a, b) => compareText(a.code, b.code));
}
