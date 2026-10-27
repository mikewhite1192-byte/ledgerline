import type { BreakCategory } from "../rules-engine/card-recon";

// The card check's words on screen, from code: the short name of each difference, the system a
// payment record lives in, and the fixed sentence a difference shows when no checked model
// sentence exists. Plain words only (docs/design-ui-ease.md).

export const CATEGORY_WORDS: Readonly<Record<BreakCategory, string>> = {
  fuel_amount_differs: "Fuel amount differs",
  purchase_not_recorded: "Fuel purchase not on file",
  card_unknown: "Card not on file",
  load_not_in_ledger: "Card load with no payment record",
  load_amount_differs: "Card load amount differs",
  missing_outside: "Not found where it was sent",
  reversed_outside: "Failed or canceled where it was sent",
  amount_differs_outside: "Amount differs where it was sent",
  pending_outside: "Still pending where it was sent",
  not_confirmed: "Not confirmed yet",
};

export const SYSTEM_WORDS: Readonly<Record<string, string>> = {
  fuel_card_sim: "the card provider",
  stripe_test: "the bank",
  qbo_sandbox: "QuickBooks",
  mock: "the test system",
};

export const FIX_WORDS: Readonly<Record<string, string>> = {
  card_match: "Approve the match",
  check_pending: "Check pending",
  retry: "Retry",
  by_hand: "By hand",
  none: "Nothing to do",
};

export const DISMISS_WORDS: Readonly<Record<string, string>> = {
  explained: "Explained",
  duplicate: "Duplicate",
  wrong_system: "Wrong system",
  other: "Other",
};

// A payment record by its kind, in words.
export const RECORD_WORDS: Readonly<Record<string, string>> = {
  advance_payout: "advance payout",
  advance_expense: "advance posted to QuickBooks",
  settlement_payout: "weekly pay payout",
  settlement_bill: "weekly pay bill in QuickBooks",
  settlement_bill_payment: "weekly pay bill payment in QuickBooks",
  invoice: "invoice in QuickBooks",
  customer_payment: "customer payment in QuickBooks",
};

// What a difference is about: the card row by its last four digits, else the payment record.
export function recordWords(input: {
  transaction: { last4: string } | null;
  record: { kind: string } | null;
}): string {
  if (input.transaction) return `card ending ${input.transaction.last4}`;
  if (input.record && Object.hasOwn(RECORD_WORDS, input.record.kind)) return RECORD_WORDS[input.record.kind];
  return "a payment record";
}

export function categoryWords(category: string): string {
  return Object.hasOwn(CATEGORY_WORDS, category) ? CATEGORY_WORDS[category as BreakCategory] : "Difference";
}

export function systemWords(system: string | null): string {
  return system !== null && Object.hasOwn(SYSTEM_WORDS, system) ? SYSTEM_WORDS[system] : "the other system";
}

// A system the check could not read in full, as its page line says it: "Bank: not connected in
// this demo". A line's system is an outside system, a payment rail's key, the books, or our own
// payment records.
const LINE_SYSTEM_WORDS: Readonly<Record<string, string>> = {
  fuel_card_sim: "Card provider",
  stripe_test: "Bank",
  qbo_sandbox: "QuickBooks",
  mock: "Test system",
  accounting: "QuickBooks",
  "payment:fuel_card": "Card provider",
  "payment:bank": "Bank",
  payment_records: "Payment records",
};

const LINE_WORDS: Readonly<Record<string, string>> = {
  not_connected: "not connected in this demo",
  over_limit: "more records than one check reads; the rest are read next time",
  too_many_rows: "more card transactions than one check reads; the oldest were compared",
  too_many_differences: "more differences than one check lists; the most serious are listed",
  too_many_records: "more payment records than one check reads; the oldest were compared",
  timeout: "did not answer in time; nothing it found before was closed",
};

export function lineWords(line: { system: string; category: string }): string {
  const system = Object.hasOwn(LINE_SYSTEM_WORDS, line.system) ? LINE_SYSTEM_WORDS[line.system] : "Another system";
  const words = Object.hasOwn(LINE_WORDS, line.category)
    ? LINE_WORDS[line.category]
    : "could not be read this time; nothing it found before was closed";
  return `${system}: ${words}.`;
}

// $1,234.56 from whole cents, or "none".
export function money(cents: number | null): string {
  if (cents === null || !Number.isSafeInteger(cents)) return "none";
  const abs = Math.abs(cents);
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.trunc(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

// "{category} on {record}: ours {a}, theirs {b}." Built by code, so it is always right.
export function fixedSentence(input: {
  category: string;
  record: string;
  ourCents: number | null;
  outsideCents: number | null;
}): string {
  return `${categoryWords(input.category)} on ${input.record}: ours ${money(input.ourCents)}, theirs ${money(input.outsideCents)}.`;
}
