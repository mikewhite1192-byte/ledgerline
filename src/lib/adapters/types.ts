import type { Queryable } from "../db";
import type { MoneyFailure, OutsideSystem, PayoutRail, SimBehavior } from "../money/types";
import type {
  AdvanceInput,
  CheckInput,
  CustomerRecord,
  LoadRecord,
  ReceivablesInput,
  SettlementInput,
} from "../rules-engine";
import type { Instant, LocalDate } from "../time/local-date";

// The outside systems behind one interface each. Nothing here moves money on its own: the money
// executor (src/lib/money/execute.ts) reserves a ledger row, then calls one of these with the
// row's request id, then settles the row with the outcome. Agent code cannot import adapters
// (eslint.config.mjs) except the TMS reads.

export type SendContext = {
  // The ledger row's id without dashes. The outside system replays the first answer for a
  // repeated request id, so a retry after a crash never makes a second record.
  requestId: string;
  timeoutMs: number;
  // The tenant's IANA zone, for any date sent outside.
  tenantZone: string;
};

export type UnknownCategory = "timeout" | "network" | "unavailable" | "unknown";
export const UNKNOWN_CATEGORIES: readonly UnknownCategory[] = [
  "timeout",
  "network",
  "unavailable",
  "unknown",
];

// An accounting invoice's email state as the outside system reports it. Read only: no adapter
// member sends anything.
export const INVOICE_EMAIL_STATUSES = ["NotSet", "NeedToSend", "EmailSent"] as const;
export type InvoiceEmailStatus = (typeof INVOICE_EMAIL_STATUSES)[number];

export type SendOutcome =
  | {
      kind: "confirmed";
      system: OutsideSystem;
      type: string;
      id: string;
      ref?: string;
      amountCents: number;
      // An invoice's email state, only when the reply carried a known one.
      emailStatus?: InvoiceEmailStatus;
    }
  | { kind: "failed"; category: MoneyFailure; httpStatus?: number }
  | { kind: "unknown"; category: UnknownCategory; httpStatus?: number };

// Where a record the outside system found stands, in the ledger's words. Each adapter maps its
// processor's own statuses into these, and anything it does not recognize to "pending":
//   succeeded  the write landed for good (a payout paid out, an accounting record created)
//   pending    the record exists but is not final yet (processing, in transit)
//   failed     it ended with no money moved (failed, returned)
//   canceled   it was called off with no money moved
// Only "succeeded" confirms a row; any other value, listed here or not, never does.
export const READ_BACK_STATUSES = ["succeeded", "pending", "failed", "canceled"] as const;
export type ReadBackStatus = (typeof READ_BACK_STATUSES)[number];

// What a read-back by request id finds. found: false is not "never happened": the row stays
// unknown and a person decides at the check limit.
export type ReadBack =
  | {
      found: true;
      system: OutsideSystem;
      type: string;
      id: string;
      ref?: string;
      amountCents: number;
      status: ReadBackStatus;
      // An invoice's email state, only when the record carried a known one.
      emailStatus?: InvoiceEmailStatus;
    }
  | { found: false };

export type Ready = { ok: true } | { ok: false; category: MoneyFailure };

// Where a fuel-card load goes: the provider's own reference for the driver's card and its last
// four digits, never a card number. simBehavior is what the simulated provider answers for this
// card; a real adapter ignores it.
export type FuelCardDestination = {
  rail: "fuel_card";
  provider: "fuel_card_sim";
  token: string;
  last4: string;
  simBehavior: SimBehavior;
};
// The bank rail carries no destination today (the provider pays its own test account).
export type PayoutDestination = FuelCardDestination;

export type PayoutRequest = {
  actionId: string;
  driverId: string;
  amountCents: number;
  // Which record this pays (memoCodeOf), never a person's name.
  memoCode: string;
  // Fixed by the row's kind (RAIL_OF_KIND). Each real rail adapter refuses another rail.
  rail: PayoutRail;
  destination?: PayoutDestination;
};

export interface PaymentAdapter {
  readonly system: "mock" | "stripe_test" | "fuel_card_sim";
  // Repeats the switch and key checks on every call.
  ready(): Promise<Ready>;
  sendPayout(p: PayoutRequest, ctx: SendContext): Promise<SendOutcome>;
  // The original payout rides along, so an adapter whose read-back is a replay of the same
  // request id (the mock, a processor's idempotent create) can make it.
  readBack(
    ref: { requestId: string; outsideId?: string | null; payout: PayoutRequest },
    ctx: SendContext,
  ): Promise<ReadBack>;
}

// kind is the rules engine's invoice line kind; it picks the accounting item for the line.
export type InvoiceLine = {
  kind: "linehaul" | "fuel_surcharge" | "detention" | "layover" | "stop" | "lumper";
  description: string;
  amountCents: number;
};
export type PayLine = { kind: string; description: string; amountCents: number };

// Every method takes the tenant's Queryable first (its connection row and id map live there).
// Run each call in its own short tenant transaction and let it return: a token refresh made
// during the call commits with it. Outside refusals come back as outcomes, not throws, from the
// create methods; ensureCustomer, ensureVendor and readBack throw a MoneyError instead.
export interface AccountingAdapter {
  readonly system: "qbo_sandbox";
  ready(q: Queryable): Promise<Ready>;
  ensureCustomer(
    q: Queryable,
    c: { id: string; code: string; name: string },
    ctx: SendContext,
  ): Promise<{ outsideId: string }>;
  ensureVendor(
    q: Queryable,
    d: { id: string; code: string; firstName: string; lastName: string; workerType: string },
    ctx: SendContext,
  ): Promise<{ outsideId: string }>;
  createInvoice(
    q: Queryable,
    inv: {
      actionId: string;
      invoiceNumber: string;
      customerOutsideId: string;
      issuedOn: LocalDate;
      dueOn: LocalDate;
      lines: InvoiceLine[];
      // The customer's billing address, recorded on the invoice so it waits in the outside
      // system's send queue. Synthetic .example addresses only; nothing is ever sent from here.
      billingEmail: string;
    },
    ctx: SendContext,
  ): Promise<SendOutcome>;
  createBill(
    q: Queryable,
    bill: {
      actionId: string;
      vendorOutsideId: string;
      driverCode: string;
      periodEnd: LocalDate;
      lines: PayLine[];
    },
    ctx: SendContext,
  ): Promise<SendOutcome>;
  payBill(
    q: Queryable,
    p: {
      actionId: string;
      billOutsideId: string;
      vendorOutsideId: string;
      amountCents: number;
      paidOn: LocalDate;
    },
    ctx: SendContext,
  ): Promise<SendOutcome>;
  createExpense(
    q: Queryable,
    e: {
      actionId: string;
      vendorOutsideId: string;
      amountCents: number;
      feeCents: number;
      onDate: LocalDate;
      docRef: string;
    },
    ctx: SendContext,
  ): Promise<SendOutcome>;
  recordCustomerPayment(
    q: Queryable,
    p: {
      actionId: string;
      customerOutsideId: string;
      paymentRef: string;
      receivedOn: LocalDate;
      amountCents: number;
      applications: { invoiceOutsideId: string; amountCents: number }[];
    },
    ctx: SendContext,
  ): Promise<SendOutcome>;
  // For a Payment, applications is required: the invoices and amounts it was asked to apply, so a
  // payment QuickBooks applied short of that never reads back as succeeded.
  readBack(
    q: Queryable,
    ref: {
      type: string;
      requestId: string;
      outsideId?: string | null;
      outsideRef?: string | null;
      // Invoice and Payment only, when no outside number is stored: our own invoice number or
      // payment reference, which the adapter keys as its create did.
      localRef?: string | null;
      // The customer or vendor the document was sent for, from the stored action. When given, a
      // document found by number that belongs to another party is never read back as ours.
      partyOutsideId?: string | null;
      // Invoice and Payment only: our customer's id, resolved to its outside id by the adapter.
      partyLocalId?: string | null;
      applications?: { invoiceOutsideId: string; amountCents: number }[];
    },
    ctx: SendContext,
  ): Promise<ReadBack>;
}

// Reads only, over the seeded tables. Safe for agent tools.
export interface TmsAdapter {
  settlementInput(q: Queryable, driverId: string, periodId: string): Promise<SettlementInput>;
  advanceInput(
    q: Queryable,
    driverId: string,
    amountCents: number,
    requestedAt: Instant,
  ): Promise<AdvanceInput>;
  checkInput(q: Queryable): Promise<CheckInput>;
  receivablesInput(q: Queryable, asOf: LocalDate): Promise<ReceivablesInput>;
  invoiceSource(
    q: Queryable,
    loadId: string,
  ): Promise<{ load: LoadRecord; customer: CustomerRecord | null } | null>;
}

