// The money ledger's vocabulary (db/migrations/0006_money_actions.sql). Every outside write the
// app makes (a payout, a post to the accounting system) is one money_actions row: reserved before
// the call, settled after it. Money is integer cents; an outcome nobody confirmed is "unknown",
// never assumed.

export const MONEY_ACTION_KINDS = [
  "advance_payout",
  "advance_expense",
  "settlement_payout",
  "settlement_bill",
  "settlement_bill_payment",
  "invoice",
  "customer_payment",
] as const;
export type MoneyActionKind = (typeof MONEY_ACTION_KINDS)[number];

export const MONEY_ACTION_STATES = ["reserved", "sent", "confirmed", "failed", "unknown"] as const;
export type MoneyActionState = (typeof MONEY_ACTION_STATES)[number];

// Categories only: an upstream message never reaches a row, a card or a page.
export const MONEY_FAILURES = [
  "disabled",
  "not_connected",
  "not_configured",
  "validation",
  "duplicate",
  "auth",
  "rate_limited",
  "unavailable",
  "timeout",
  "network",
  "amount_mismatch",
  // A read-back found the record failed or canceled: no money moved.
  "outside_failed",
  // The card provider declined the load: definite, no money moved (0017).
  "declined",
  "unknown",
] as const;
export type MoneyFailure = (typeof MONEY_FAILURES)[number];

// The same list as money_actions_outside_system_check (0017).
export const OUTSIDE_SYSTEMS = ["mock", "stripe_test", "qbo_sandbox", "fuel_card_sim"] as const;
export type OutsideSystem = (typeof OUTSIDE_SYSTEMS)[number];

// Where a payout lands. Fixed per kind in code, never chosen per row: an advance loads the
// driver's fuel card, a weekly settlement goes to the driver's bank. No rail column exists on
// money_actions, because the kind already says it; outside_system says which provider answered.
export const PAYOUT_RAILS = ["fuel_card", "bank"] as const;
export type PayoutRail = (typeof PAYOUT_RAILS)[number];

export const RAIL_OF_KIND: Readonly<Record<"advance_payout" | "settlement_payout", PayoutRail>> = {
  advance_payout: "fuel_card",
  settlement_payout: "bank",
};

// The rail a kind pays on, or null for a kind that moves no money (an accounting post).
export function railOf(kind: unknown): PayoutRail | null {
  if (kind === "advance_payout" || kind === "settlement_payout") return RAIL_OF_KIND[kind];
  return null;
}

// What the simulated fuel-card provider answers for a card (driver_cards.sim_behavior, 0017).
// offline is for tests only; the seed never plants it.
export const SIM_BEHAVIORS = ["ok", "declined", "slow", "offline"] as const;
export type SimBehavior = (typeof SIM_BEHAVIORS)[number];

export type MoneyChannel = "payment" | "accounting";
export type SubjectTable = "advances" | "settlements" | "invoices" | "customer_payments";
export type CounterpartyTable = "drivers" | "customers";
export type SettledVia = "response" | "read_back" | "refused";
export const PROPOSERS = ["agent", "person"] as const;
export type ProposedBy = (typeof PROPOSERS)[number];

export type KindShape = {
  channel: MoneyChannel;
  subjectTable: SubjectTable;
  counterpartyTable: CounterpartyTable;
};

// The same pairings the table's CHECKs enforce.
export const KIND_SHAPES: Readonly<Record<MoneyActionKind, KindShape>> = {
  advance_payout: { channel: "payment", subjectTable: "advances", counterpartyTable: "drivers" },
  advance_expense: { channel: "accounting", subjectTable: "advances", counterpartyTable: "drivers" },
  settlement_payout: {
    channel: "payment",
    subjectTable: "settlements",
    counterpartyTable: "drivers",
  },
  settlement_bill: {
    channel: "accounting",
    subjectTable: "settlements",
    counterpartyTable: "drivers",
  },
  settlement_bill_payment: {
    channel: "accounting",
    subjectTable: "settlements",
    counterpartyTable: "drivers",
  },
  invoice: { channel: "accounting", subjectTable: "invoices", counterpartyTable: "customers" },
  customer_payment: {
    channel: "accounting",
    subjectTable: "customer_payments",
    counterpartyTable: "customers",
  },
};

// The statuses each subject table allows (0005). customer_payments has none.
export const SUBJECT_STATUSES = {
  advances: ["requested", "approved", "paid", "rejected", "cancelled"],
  settlements: ["draft", "approved", "paid"],
  invoices: ["open", "partially_paid", "paid", "void"],
  customer_payments: [],
} as const satisfies Record<SubjectTable, readonly string[]>;
export type SubjectStatus<T extends SubjectTable> = (typeof SUBJECT_STATUSES)[T][number];

export const MAX_ATTEMPT = 20;
// At this many read-back checks a row needs a person; the reconcile pass skips it.
export const MAX_CHECKS = 50;
// Exclusive: every amount is a positive safe integer under 10^9 cents.
export const AMOUNT_LIMIT_CENTS = 1_000_000_000;

// What a caller asks for. The executor turns it into a reserved row.
export type MoneyDraft = {
  kind: MoneyActionKind;
  subjectId: string;
  // The driver or customer the subject belongs to; checked against the subject row.
  counterpartyId: string;
  amountCents: number;
  // 1 for the first try; a person retries a definite failure as attempt + 1.
  attempt?: number;
  proposedBy: ProposedBy;
  proposalId?: string | null;
  traceId?: string | null;
  // The subject statuses this action may start from, compared whole. Required for every subject
  // table that has a status; must be absent for customer_payments.
  subjectStatuses?: readonly string[];
  // The approval batch that reserved this row (one "Approve all clean" over a pay week). Written
  // at INSERT and never changed (the guard refuses it); null on every single approval.
  batchId?: string | null;
};

// One money_actions row, camelCase. Timestamps are ISO instants in UTC.
export type MoneyAction = {
  id: string;
  tenantId: string;
  kind: MoneyActionKind;
  channel: MoneyChannel;
  subjectTable: SubjectTable;
  subjectId: string;
  attempt: number;
  idempotencyKey: string;
  requestId: string;
  amountCents: number;
  counterpartyTable: CounterpartyTable;
  counterpartyId: string;
  state: MoneyActionState;
  failureCategory: MoneyFailure | null;
  settledVia: SettledVia | null;
  outsideSystem: OutsideSystem | null;
  outsideType: string | null;
  outsideId: string | null;
  outsideRef: string | null;
  outsideAmountCents: number | null;
  proposedBy: ProposedBy;
  proposalId: string | null;
  traceId: string | null;
  approverMembershipId: string;
  batchId: string | null;
  checkCount: number;
  createdAt: string;
  sentAt: string | null;
  settledAt: string | null;
  lastCheckedAt: string | null;
  // Whole seconds since sent_at, by the database's clock; null until sent.
  sentSecondsAgo: number | null;
};

export const isSettled = (a: Pick<MoneyAction, "state">): boolean =>
  a.state === "confirmed" || a.state === "failed";

// Carries a category, and the outside HTTP status when there was one. Never upstream text.
export class MoneyError extends Error {
  readonly category: MoneyFailure;
  readonly httpStatus?: number;

  constructor(category: MoneyFailure, httpStatus?: number) {
    super(httpStatus ? `money: ${category} (${httpStatus})` : `money: ${category}`);
    this.name = "MoneyError";
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

export function isMoneyFailure(value: unknown): value is MoneyFailure {
  return typeof value === "string" && (MONEY_FAILURES as readonly string[]).includes(value);
}

declare const approvalBrand: unique symbol;

// A person who may approve a money action in this tenant, resolved from the request's verified
// session inside its tenant transaction. Only src/lib/money/approval.ts makes one, and agent code
// cannot import that file (eslint.config.mjs), so an agent tool never holds an Approval.
export type Approval = {
  readonly membershipId: string;
  readonly role: "admin" | "staff";
  readonly sub: string;
  readonly [approvalBrand]: true;
};
