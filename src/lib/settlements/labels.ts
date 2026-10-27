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

// How a settlement_approve card ended (proposals.decision_note) and why a button was refused.
export const SETTLEMENT_OUTCOMES: Readonly<Record<string, string>> = {
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
  not_open: "That week is not open for a pay run.",
  before_start: "Pay runs here start with a later week.",
  forbidden: "You do not have access to this carrier.",
};

export function settlementOutcome(category: string | null | undefined): string {
  return typeof category === "string" && Object.hasOwn(SETTLEMENT_OUTCOMES, category)
    ? SETTLEMENT_OUTCOMES[category]
    : "That did not go through. Nothing changed.";
}

export const LEG_LABELS = {
  settlement_payout: "Payout",
  settlement_bill: "Bill in QuickBooks",
  settlement_bill_payment: "Bill payment in QuickBooks",
} as const;
