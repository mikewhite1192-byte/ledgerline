import { STAFF_ONLY_NOTE } from "../../components/app/staff-only";
import type { ParkReason } from "./reconcile";

// Fixed words for the pay run screens. Categories reach a page; these turn them into text.

export const PARK_LABELS: Readonly<Record<ParkReason, string>> = {
  line_amount_changed: "A pay line changed since the draft",
  line_missing: "A pay line is gone since the draft",
  line_added: "A new pay line appeared since the draft",
  line_sources_changed: "A pay line now comes from different records",
  total_changed: "The totals changed since the draft",
  source_missing: "A record behind a pay line no longer exists",
  source_settled_elsewhere: "A reimbursement or deduction was already paid on another week",
  source_changed: "A load behind a pay line is no longer delivered in this week",
  advance_overrecovered: "An advance would be taken back for more than is owed",
  schedule_inactive: "A deduction schedule is no longer active this week",
};

export function parkLabel(reason: string | null | undefined): string {
  return typeof reason === "string" && Object.hasOwn(PARK_LABELS, reason)
    ? PARK_LABELS[reason as ParkReason]
    : "This paystub needs a fresh run";
}

// Why a paystub is not clean, for the table and the record page.
export const EXCEPTION_LABELS: Readonly<Record<string, string>> = {
  load_rate_missing: "A delivered load has no rate",
  net_below_zero: "Deductions were more than pay; net is $0",
  newer_is_duplicate: "An advance looks like a duplicate",
  purchase_on_other_driver: "Fuel charged to the wrong driver",
  load_on_other_driver: "Fuel tied to another driver's load",
  purchase_not_found: "A fuel charge has no matching purchase",
  no_load_that_day: "Insurance on a day with no load",
  no_reimbursement: "A lumper the driver paid has no reimbursement",
  rate_missing: "A delivered load has no rate",
  over_limit: "Advances are over the driver's limit",
};

export function exceptionLabel(category: string): string {
  return Object.hasOwn(EXCEPTION_LABELS, category) ? EXCEPTION_LABELS[category] : "Needs a look";
}

// A lost or unreadable reply, or a server error: the work may have happened (a payout among it), so
// this never says nothing changed.
const NOT_CONFIRMED = "Not confirmed yet: this may have gone through. Refresh the page to see where it stands before you try again.";

// A category with no sentence of its own: it claims nothing about what happened, either way.
export const SETTLEMENT_OUTCOME_FALLBACK = "Check where this stands before you try again.";

// How a settlement_approve card ended (proposals.decision_note) and why a button was refused.
export const SETTLEMENT_OUTCOMES: Readonly<Record<string, string>> = {
  unknown: NOT_CONFIRMED,
  unavailable: NOT_CONFIRMED,
  // Retry payout refused before this try sent anything.
  failed: "The payout did not go out on this try. Check the money legs below before you try again.",
  not_paid: "Approved. Payouts are off in this environment, so nothing was sent.",
  no_payout: "Approved with no payout: net pay is $0 and the rest carries to next week.",
  parked: "Parked: the paystub no longer matches its records. Run the week to recompute.",
  stale: "The paystub changed after this was proposed. Run the week for a fresh draft.",
  superseded: "Replaced by a newer draft.",
  disabled: "This is off in this environment.",
  not_connected: "QuickBooks is not connected, so the bill was not posted.",
  not_configured: "This step needs the one before it to finish first.",
  attempts_used: "The payout was tried the most times allowed. Check the payment system first.",
  in_flight: "A payout for this paystub is still being checked. Refresh in a minute.",
  not_paid_yet: "The payout has not been confirmed yet.",
  already_posted: "This is already posted to QuickBooks.",
  already_paid: "This paystub is already paid.",
  role: "An admin must approve an amount this large.",
  validation: "Something in the request is not valid. Nothing was saved.",
  not_found: "That paystub was not found.",
  amount_mismatch: "The outside system holds a different amount. Check it there by hand.",
  not_approved: "Only an approved paystub can be paid.",
  not_booked: "The payout went out, but the paystub was not marked paid. Retry booking finishes it without paying again.",
  records_changed: "Not paid: the records behind this paystub changed after it was approved. Nothing was sent.",
  not_open: "That week is not open for a pay run.",
  before_start: "Pay runs here start with a later week.",
  forbidden: "You do not have access to this carrier.",
  // A demo visitor pressed a staff-only button; the staff check refused it before any work.
  judge: STAFF_ONLY_NOTE,
};

export function settlementOutcome(category: string | null | undefined): string {
  return typeof category === "string" && Object.hasOwn(SETTLEMENT_OUTCOMES, category)
    ? SETTLEMENT_OUTCOMES[category]
    : SETTLEMENT_OUTCOME_FALLBACK;
}

export const LEG_LABELS = {
  settlement_payout: "Payout",
  settlement_bill: "Bill in QuickBooks",
  settlement_bill_payment: "Bill payment in QuickBooks",
} as const;

export const LEG_NOT_SENT = "Not sent because the leg before it failed";

type LegFacts = {
  kind: string;
  attempt: number;
  state: string;
  failureCategory: string | null;
  settledVia: string | null;
  batchId: string | null;
};

const LEG_BEFORE: Readonly<Record<string, string>> = {
  settlement_bill: "settlement_payout",
  settlement_bill_payment: "settlement_bill",
};

// The settlement words for why one paystub's money leg did not go, or null when the category's own
// words fit. The batch drain refuses a bill leg whose leg before it in the same batch failed, as
// validation settled as refused (drain.ts). The drain refuses a leg for any other reason only once
// the leg before it is confirmed, and a settled row never changes, so that whole pattern is the
// drain's refusal. The only other path to it is "Post to QuickBooks" replaying a batch row the
// drain had not refused yet while the accounting connection answers validation.
export function legFailureLabel(row: LegFacts, rows: readonly LegFacts[]): string | null {
  const kindBefore = Object.hasOwn(LEG_BEFORE, row.kind) ? LEG_BEFORE[row.kind] : null;
  if (kindBefore === null || row.batchId === null) return null;
  if (row.state !== "failed" || row.settledVia !== "refused" || row.failureCategory !== "validation") return null;
  const before = rows
    .filter((r) => r.kind === kindBefore && r.batchId === row.batchId)
    .reduce<LegFacts | null>((top, r) => (top === null || r.attempt > top.attempt ? r : top), null);
  return before?.state === "failed" ? LEG_NOT_SENT : null;
}
