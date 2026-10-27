import { isCanonicalUuid } from "../../../money/keys";
import { centsToDecimalString, decimalToCents } from "../../../money/format";
import { AMOUNT_LIMIT_CENTS, MoneyError } from "../../../money/types";
import { isLocalDate, type LocalDate } from "../../../time/local-date";
import type { InvoiceLine, PayLine } from "../../types";
import { decimalField } from "./wire";
import {
  ACCOUNT_FOR_PAY_LINE,
  accountForPayLine,
  ITEM_FOR_LINE,
  INVOICE_LINE_KINDS,
  type AccountMap,
  type ItemMap,
} from "./mapping";

// The QuickBooks bodies, built from Intuit's public API reference, and the reading of its
// replies. Pure: no HTTP, no database. Every value is checked before it goes into a body, and an
// amount travels as a decimal written from integer cents.

export const DOC_TYPES = ["Invoice", "Bill", "BillPayment", "Purchase", "Payment"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export type EntityType = DocType | "Customer" | "Vendor" | "Account" | "Item";

// The path segment for each entity.
export const PATH_OF: Record<EntityType, string> = {
  Invoice: "invoice",
  Bill: "bill",
  BillPayment: "billpayment",
  Purchase: "purchase",
  Payment: "payment",
  Customer: "customer",
  Vendor: "vendor",
  Account: "account",
  Item: "item",
};

// The field a document is found by when its id is not known.
export const REF_FIELD: Record<DocType, "DocNumber" | "PaymentRefNum"> = {
  Invoice: "DocNumber",
  Bill: "DocNumber",
  BillPayment: "DocNumber",
  Purchase: "DocNumber",
  Payment: "PaymentRefNum",
};

const OUTSIDE_ID = /^[0-9]{1,20}$/;
// Intuit's 21-character limit on a document number; only letters, digits and dashes here, so a
// number never needs escaping in a query. Longer numbers are refused, never cut (two cut numbers
// could match).
const DOC_NUMBER = /^[A-Za-z0-9-]{1,21}$/;

function fail(): never {
  throw new MoneyError("validation");
}

export function checkOutsideId(id: unknown): string {
  return typeof id === "string" && OUTSIDE_ID.test(id) ? id : fail();
}

export function checkDocNumber(ref: unknown): string {
  return typeof ref === "string" && DOC_NUMBER.test(ref) ? ref : fail();
}

function checkDate(d: unknown): LocalDate {
  return isLocalDate(d) ? d : fail();
}

// Printable text with no control characters, trimmed, 1 to max characters.
export function checkText(t: unknown, max: number): string {
  if (typeof t !== "string" || /[\u0000-\u001f\u007f]/.test(t)) fail();
  const v = t.trim();
  return v.length >= 1 && v.length <= max ? v : fail();
}

function checkCode(code: unknown): string {
  return typeof code === "string" && /^[A-Z0-9-]{2,20}$/.test(code) ? code : fail();
}

// Cents for a line: a safe integer inside the ledger's limit, never zero.
function checkLineCents(c: unknown): number {
  if (typeof c !== "number" || !Number.isSafeInteger(c) || c === 0) fail();
  return Math.abs(c) < AMOUNT_LIMIT_CENTS ? c : fail();
}

const amount = (cents: number) => decimalField(centsToDecimalString(cents));
// The private note every document this adapter makes carries.
const NOTE_PREFIX = "LedgerLine action ";
const note = (actionId: string) => `${NOTE_PREFIX}${actionId}`;

function checkAction(actionId: unknown): string {
  return isCanonicalUuid(actionId) ? actionId : fail();
}

// ---- The tenant's codes (D2: several tenants may post into one company) ----

// T and the first 12 hex digits of the tenant's id, uppercase, so tenant 5b0e6f1a-2c3d-... is
// T5B0E6F1A2C3D. Taken from the id, never the slug: two slugs can share initials, and a customer
// or vendor is found and adopted by its display name, so two tenants with one code and one
// party name would share that party. The first 12 hex digits of a v4 id are random.
export function tenantCodeOf(tenantId: unknown): string {
  if (!isCanonicalUuid(tenantId)) fail();
  return `T${tenantId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

// The tenant's key in a settlement bill number: the first 5 characters of its code (T and the
// first 4 hex digits of its id), so a bill reads with its vendor's name.
export function billKeyOf(tenantId: unknown): string {
  return tenantCodeOf(tenantId).slice(0, 5);
}

// ---- Names (D2: the tenant's code first, so two tenants in one company never collide) ----

export function customerDisplayName(tenantCode: string, c: { code: string; name: string }): string {
  return `${tenantCode} ${checkText(c.name, 200)} (${checkCode(c.code)})`;
}

export function vendorDisplayName(
  tenantCode: string,
  d: { code: string; firstName: string; lastName: string },
): string {
  return `${tenantCode} ${checkText(d.lastName, 100)}, ${checkText(d.firstName, 100)} (${checkCode(d.code)})`;
}

export function customerBody(displayName: string): Record<string, unknown> {
  return { DisplayName: displayName };
}

export function vendorBody(displayName: string, workerType: string): Record<string, unknown> {
  if (workerType !== "company" && workerType !== "owner_operator") fail();
  return { DisplayName: displayName, Vendor1099: workerType === "owner_operator" };
}

// ---- Documents ----

const BILL_KEY = /^T[0-9A-F]{4}$/;

// <tenant key>-<our number>: an invoice's number or a payment's reference as QuickBooks keeps it.
// Every tenant numbers its invoices from 10001 under a prefix made of its slug's initials, and
// the tenants share one sandbox company, so two tenants whose slugs share initials would send the
// same number. The key is the tenant's document key (0015), unique in the database, so two
// tenants never share one even when their ids start alike, and the adapter adopts a document
// only when its customer is one of the tenant's own. The invoice prefix and the payment form's
// reference are capped so ours fit Intuit's 21; a longer result is refused, never cut.
export function keyedDocNumber(tenantKey: unknown, localRef: unknown): string {
  if (typeof tenantKey !== "string" || !BILL_KEY.test(tenantKey)) fail();
  return checkDocNumber(`${tenantKey}-${checkDocNumber(localRef)}`);
}

export function invoiceBody(
  inv: {
    actionId: string;
    invoiceNumber: string;
    customerOutsideId: string;
    issuedOn: LocalDate;
    dueOn: LocalDate;
    lines: InvoiceLine[];
  },
  items: ItemMap,
  tenantKey: string,
): { body: Record<string, unknown>; totalCents: number; docNumber: string } {
  if (!Array.isArray(inv.lines) || inv.lines.length < 1 || inv.lines.length > 100) fail();
  let total = 0;
  const Line = inv.lines.map((l) => {
    if (!(INVOICE_LINE_KINDS as readonly unknown[]).includes(l?.kind)) fail();
    const cents = checkLineCents(l.amountCents);
    if (cents < 0) fail();
    total += cents;
    return {
      DetailType: "SalesItemLineDetail",
      Amount: amount(cents),
      Description: checkText(l.description, 4000),
      SalesItemLineDetail: {
        ItemRef: { value: checkOutsideId(items[ITEM_FOR_LINE[l.kind]]) },
        Qty: 1,
        UnitPrice: amount(cents),
      },
    };
  });
  if (total >= AMOUNT_LIMIT_CENTS) fail();
  const docNumber = keyedDocNumber(tenantKey, inv.invoiceNumber);
  return {
    docNumber,
    totalCents: total,
    body: {
      CustomerRef: { value: checkOutsideId(inv.customerOutsideId) },
      DocNumber: docNumber,
      TxnDate: checkDate(inv.issuedOn),
      DueDate: checkDate(inv.dueOn),
      PrivateNote: note(checkAction(inv.actionId)),
      Line,
    },
  };
}

// <tenant key>-YYMMDD-<driver code>, so T5B0E-261107-BR-D07 is the week ending 2026-11-07 for
// driver BR-D07 of the tenant whose id starts 5b0e. The key keeps two tenants in one company
// with the same driver code and period end apart. Were two tenants' keys ever equal (1 in 65,536
// for a pair), the second bill is refused as held by another party, never adopted, because its
// vendor differs. A driver code of up to 8 characters fits Intuit's 21; a longer result is
// refused, never cut.
export function billDocNumber(tenantKey: string, driverCode: string, periodEnd: LocalDate): string {
  if (typeof tenantKey !== "string" || !BILL_KEY.test(tenantKey)) fail();
  const d = checkDate(periodEnd);
  return checkDocNumber(
    `${tenantKey}-${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${checkCode(driverCode)}`,
  );
}

const EARNINGS = new Set(["load_pay", "accessorial_pay", "reimbursement"]);

export function billBody(
  bill: {
    actionId: string;
    vendorOutsideId: string;
    driverCode: string;
    periodEnd: LocalDate;
    lines: PayLine[];
  },
  accounts: AccountMap,
  tenantKey: string,
): { body: Record<string, unknown>; totalCents: number; docNumber: string } {
  if (!Array.isArray(bill.lines) || bill.lines.length > 200) fail();
  let total = 0;
  const Line = bill.lines
    .filter((l) => l?.amountCents !== 0)
    .map((l) => {
      if (typeof l?.kind !== "string" || !Object.prototype.hasOwnProperty.call(ACCOUNT_FOR_PAY_LINE, l.kind)) fail();
      const cents = checkLineCents(l.amountCents);
      // Earnings are positive and deductions negative, or the bill would not total the net.
      if (EARNINGS.has(l.kind) !== cents > 0) fail();
      total += cents;
      return {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: amount(cents),
        Description: checkText(l.description, 4000),
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: checkOutsideId(accounts[accountForPayLine(l.kind)]) },
        },
      };
    });
  if (Line.length < 1 || total <= 0 || total >= AMOUNT_LIMIT_CENTS) fail();
  const docNumber = billDocNumber(tenantKey, bill.driverCode, bill.periodEnd);
  return {
    docNumber,
    totalCents: total,
    body: {
      VendorRef: { value: checkOutsideId(bill.vendorOutsideId) },
      DocNumber: docNumber,
      TxnDate: checkDate(bill.periodEnd),
      PrivateNote: note(checkAction(bill.actionId)),
      Line,
    },
  };
}

function checkAmount(c: unknown): number {
  if (typeof c !== "number" || !Number.isSafeInteger(c) || c <= 0 || c >= AMOUNT_LIMIT_CENTS) {
    fail();
  }
  return c;
}

// One bill payment per bill, so the bill's id names it.
export function billPaymentDocNumber(billOutsideId: string): string {
  return checkDocNumber(`BP-${checkOutsideId(billOutsideId)}`);
}

export function billPaymentBody(
  p: {
    actionId: string;
    billOutsideId: string;
    vendorOutsideId: string;
    amountCents: number;
    paidOn: LocalDate;
  },
  accounts: AccountMap,
): { body: Record<string, unknown>; totalCents: number; docNumber: string } {
  const cents = checkAmount(p.amountCents);
  const docNumber = billPaymentDocNumber(p.billOutsideId);
  return {
    docNumber,
    totalCents: cents,
    body: {
      VendorRef: { value: checkOutsideId(p.vendorOutsideId) },
      PayType: "Check",
      CheckPayment: { BankAccountRef: { value: checkOutsideId(accounts.ledgerline_clearing) } },
      TotalAmt: amount(cents),
      TxnDate: checkDate(p.paidOn),
      DocNumber: docNumber,
      PrivateNote: note(checkAction(p.actionId)),
      Line: [
        {
          Amount: amount(cents),
          LinkedTxn: [{ TxnId: checkOutsideId(p.billOutsideId), TxnType: "Bill" }],
        },
      ],
    },
  };
}

export function purchaseBody(
  e: {
    actionId: string;
    vendorOutsideId: string;
    amountCents: number;
    feeCents: number;
    onDate: LocalDate;
    docRef: string;
  },
  accounts: AccountMap,
): { body: Record<string, unknown>; totalCents: number; docNumber: string } {
  const cents = checkAmount(e.amountCents);
  if (typeof e.feeCents !== "number" || !Number.isSafeInteger(e.feeCents) || e.feeCents < 0) fail();
  const total = cents + e.feeCents;
  if (total >= AMOUNT_LIMIT_CENTS) fail();
  const line = (c: number, role: "driver_advances" | "driver_chargebacks", text: string) => ({
    DetailType: "AccountBasedExpenseLineDetail",
    Amount: amount(c),
    Description: text,
    AccountBasedExpenseLineDetail: { AccountRef: { value: checkOutsideId(accounts[role]) } },
  });
  const Line = [line(cents, "driver_advances", "Driver advance")];
  if (e.feeCents > 0) Line.push(line(e.feeCents, "driver_chargebacks", "Advance fee"));
  const docNumber = checkDocNumber(e.docRef);
  return {
    docNumber,
    totalCents: total,
    body: {
      PaymentType: "Check",
      AccountRef: { value: checkOutsideId(accounts.ledgerline_clearing) },
      EntityRef: { value: checkOutsideId(e.vendorOutsideId), type: "Vendor" },
      TxnDate: checkDate(e.onDate),
      DocNumber: docNumber,
      PrivateNote: note(checkAction(e.actionId)),
      Line,
    },
  };
}

export type Application = { invoiceOutsideId: string; amountCents: number };

// The invoices a customer payment applies to, each checked; one invoice at most once.
export function checkApplications(apps: unknown): Application[] {
  if (!Array.isArray(apps) || apps.length > 100) fail();
  const seen = new Set<string>();
  return apps.map((a) => {
    const invoice = checkOutsideId(a?.invoiceOutsideId);
    if (seen.has(invoice)) fail();
    seen.add(invoice);
    return { invoiceOutsideId: invoice, amountCents: checkAmount(a.amountCents) };
  });
}

export function paymentBody(
  p: {
    actionId: string;
    customerOutsideId: string;
    paymentRef: string;
    receivedOn: LocalDate;
    amountCents: number;
    applications: Application[];
  },
  accounts: AccountMap,
  tenantKey: string,
): { body: Record<string, unknown>; totalCents: number; docNumber: string; applications: Application[] } {
  const cents = checkAmount(p.amountCents);
  const applications = checkApplications(p.applications);
  const applied = applications.reduce((sum, a) => sum + a.amountCents, 0);
  // Any excess stays unapplied credit in the company; more applied than received is refused.
  if (applied > cents) fail();
  const ref = keyedDocNumber(tenantKey, p.paymentRef);
  return {
    docNumber: ref,
    totalCents: cents,
    applications,
    body: {
      CustomerRef: { value: checkOutsideId(p.customerOutsideId) },
      TotalAmt: amount(cents),
      PaymentRefNum: ref,
      TxnDate: checkDate(p.receivedOn),
      DepositToAccountRef: { value: checkOutsideId(accounts.ledgerline_clearing) },
      PrivateNote: note(checkAction(p.actionId)),
      Line: applications.map((a) => ({
        Amount: amount(a.amountCents),
        LinkedTxn: [{ TxnId: a.invoiceOutsideId, TxnType: "Invoice" }],
      })),
    },
  };
}

// ---- Replies ----

// One applied line of a customer payment: the invoice and the cents QuickBooks applied to it.
export type AppliedLine = { invoiceId: string; cents: number };

export type Found = {
  id: string;
  ref: string | null;
  // null when the record carries no readable total.
  amountCents: number | null;
  // The customer or vendor it belongs to, for an adoption check.
  partyId: string | null;
  // QuickBooks keeps a voided document: it reads back with a zero total and a private note that
  // starts "Voided" (measured 2026-10-27).
  voided: boolean;
  // Whether the private note starts the way ours do. Logged only, never a reason to adopt.
  ourNote: boolean;
  // Payment only, null for other types: the applied lines, null when one is out of shape.
  applied: AppliedLine[] | null;
  // Payment only, null for other types: the cents left unapplied, null when unreadable.
  unappliedCents: number | null;
};

function cents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  try {
    const c = decimalToCents(String(v));
    return Number.isSafeInteger(c) ? c : null;
  } catch {
    return null;
  }
}

function refValue(v: unknown): string | null {
  const value = typeof v === "object" && v !== null ? (v as { value?: unknown }).value : null;
  return typeof value === "string" && OUTSIDE_ID.test(value) ? value : null;
}

// A payment's lines as applied: each line links exactly one invoice. No list is no lines (an
// empty list is left out of a reply); anything else out of shape makes the whole list unreadable.
function appliedLines(lines: unknown): AppliedLine[] | null {
  if (lines === undefined) return [];
  if (!Array.isArray(lines)) return null;
  const out: AppliedLine[] = [];
  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) return null;
    const line = raw as Record<string, unknown>;
    const links = line.LinkedTxn;
    if (!Array.isArray(links) || links.length !== 1) return null;
    const link = links[0] as Record<string, unknown> | null;
    if (typeof link !== "object" || link === null || link.TxnType !== "Invoice") return null;
    if (typeof link.TxnId !== "string" || !OUTSIDE_ID.test(link.TxnId)) return null;
    const c = cents(line.Amount);
    if (c === null) return null;
    out.push({ invoiceId: link.TxnId, cents: c });
  }
  return out;
}

// One record of the given type from an entity reply ({ "Invoice": {...} }) or a query row.
export function recordOf(type: EntityType, raw: unknown): Found | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.Id !== "string" || !OUTSIDE_ID.test(r.Id)) return null;
  const refField = (DOC_TYPES as readonly string[]).includes(type)
    ? REF_FIELD[type as DocType]
    : null;
  const ref = refField && typeof r[refField] === "string" ? (r[refField] as string) : null;
  const party =
    refValue(r.CustomerRef) ?? refValue(r.VendorRef) ?? refValue(r.EntityRef) ?? null;
  const payment = type === "Payment";
  return {
    id: r.Id,
    ref,
    amountCents: cents(r.TotalAmt),
    partyId: party,
    voided: typeof r.PrivateNote === "string" && r.PrivateNote.startsWith("Voided"),
    ourNote: typeof r.PrivateNote === "string" && r.PrivateNote.startsWith(NOTE_PREFIX),
    applied: payment ? appliedLines(r.Line) : null,
    unappliedCents: payment ? cents(r.UnappliedAmt) : null,
  };
}

// A document that no longer carries its amount: voided, or zeroed. Every document this adapter
// builds totals above zero (lines are never zero, invoice lines never negative, a bill nets above
// zero), so neither is ever the record that was approved.
export function isVoided(f: Found): boolean {
  return f.voided || f.amountCents === 0;
}

// Whether a customer payment landed as asked: each invoice we named got exactly the cents we
// asked, there is no other line, and the unapplied rest is exactly what we left unapplied.
// QuickBooks does not refuse an application over an invoice's open balance: it lowers the line
// to the balance and reports the rest as unapplied, with the total as sent (measured 2026-10-27),
// so the total alone cannot show the cut.
export function appliedAsAsked(f: Found, asked: readonly Application[]): boolean {
  if (f.amountCents === null || f.applied === null || f.unappliedCents === null) return false;
  if (f.applied.length !== asked.length) return false;
  const want = new Map(asked.map((a) => [a.invoiceOutsideId, a.amountCents]));
  if (want.size !== asked.length) return false;
  const seen = new Set<string>();
  let applied = 0;
  for (const line of f.applied) {
    if (seen.has(line.invoiceId) || want.get(line.invoiceId) !== line.cents) return false;
    seen.add(line.invoiceId);
    applied += line.cents;
  }
  return f.unappliedCents === f.amountCents - applied;
}

export function entityOf(type: EntityType, body: Record<string, unknown>): Found | null {
  return recordOf(type, body[type]);
}

// The rows of a query reply for one entity; an empty answer has no list at all.
export function queryRows(type: EntityType, body: Record<string, unknown>): Found[] | null {
  const qr = body.QueryResponse;
  if (typeof qr !== "object" || qr === null) return null;
  const list = (qr as Record<string, unknown>)[type];
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const rows = list.map((x) => recordOf(type, x));
  return rows.every((x): x is Found => x !== null) ? rows : null;
}
