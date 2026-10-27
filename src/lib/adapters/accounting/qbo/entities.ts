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
const note = (actionId: string) => `LedgerLine action ${actionId}`;

function checkAction(actionId: unknown): string {
  return isCanonicalUuid(actionId) ? actionId : fail();
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
  const docNumber = checkDocNumber(inv.invoiceNumber);
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

// STL-YYMMDD-<driver code>: the period end compacted so a 6-character driver code fits Intuit's
// 21 characters; a longer result is refused, never cut.
export function billDocNumber(driverCode: string, periodEnd: LocalDate): string {
  const d = checkDate(periodEnd);
  return checkDocNumber(`STL-${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${checkCode(driverCode)}`);
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
  const docNumber = billDocNumber(bill.driverCode, bill.periodEnd);
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

export function paymentBody(
  p: {
    actionId: string;
    customerOutsideId: string;
    paymentRef: string;
    receivedOn: LocalDate;
    amountCents: number;
    applications: { invoiceOutsideId: string; amountCents: number }[];
  },
  accounts: AccountMap,
): { body: Record<string, unknown>; totalCents: number; docNumber: string } {
  const cents = checkAmount(p.amountCents);
  if (!Array.isArray(p.applications) || p.applications.length > 100) fail();
  let applied = 0;
  const seen = new Set<string>();
  const Line = p.applications.map((a) => {
    const invoice = checkOutsideId(a?.invoiceOutsideId);
    if (seen.has(invoice)) fail();
    seen.add(invoice);
    const c = checkAmount(a.amountCents);
    applied += c;
    return { Amount: amount(c), LinkedTxn: [{ TxnId: invoice, TxnType: "Invoice" }] };
  });
  // Any excess stays unapplied credit in the company; more applied than received is refused.
  if (applied > cents) fail();
  const ref = checkDocNumber(p.paymentRef);
  return {
    docNumber: ref,
    totalCents: cents,
    body: {
      CustomerRef: { value: checkOutsideId(p.customerOutsideId) },
      TotalAmt: amount(cents),
      PaymentRefNum: ref,
      TxnDate: checkDate(p.receivedOn),
      DepositToAccountRef: { value: checkOutsideId(accounts.ledgerline_clearing) },
      PrivateNote: note(checkAction(p.actionId)),
      Line,
    },
  };
}

// ---- Replies ----

export type Found = {
  id: string;
  ref: string | null;
  // null when the record carries no readable total.
  amountCents: number | null;
  // The customer or vendor it belongs to, for an adoption check.
  partyId: string | null;
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
  return { id: r.Id, ref, amountCents: cents(r.TotalAmt), partyId: party };
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
