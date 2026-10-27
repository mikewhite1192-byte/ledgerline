import type { InvoiceResult } from "../rules-engine/types";

// Fixed words for the invoice screens. Categories only reach a page; these turn them into text.

export type QueueReason = Extract<InvoiceResult, { ok: false }>["reason"];

export const QUEUE_REASON_LABELS: Readonly<Record<QueueReason, string>> = {
  missing_rate: "No rate on the load",
  missing_customer: "No customer on the load",
  not_delivered: "Not delivered yet",
};

// Why an invoice proposal ended the way it did (proposals.decision_note), and why posting or a
// payment was refused. Anything not listed shows the fallback.
export const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  not_posted: "Invoiced here. Posting to QuickBooks is off in this environment.",
  not_connected: "Invoiced here. QuickBooks is not connected, so it was not posted.",
  not_configured: "Recorded here. QuickBooks is not set up for this yet, so it was not posted.",
  stale: "The load changed after this was proposed. Refresh the queue for a fresh total.",
  superseded: "Replaced by a newer proposal.",
  posted_outside: "This payment is already in QuickBooks, so it must be moved there by hand.",
  duplicate_ref: "A different payment already uses that reference.",
  over_applied: "An application is more than that invoice still owes, or more than the payment.",
  limit: "Too many payments recorded today, or the amount is over the cap.",
  validation: "Something in the form is not valid. Nothing was saved.",
  attempts_used: "This invoice was tried the most times allowed. Check QuickBooks first.",
  already_posted: "This is already posted to QuickBooks.",
  disabled: "This is off in this environment.",
  amount_mismatch: "QuickBooks holds this number at a different amount. Check it there by hand.",
  // The reply was lost or could not be read, or the service was down: the work may have happened,
  // so these never say nothing changed.
  unknown: "The outcome is not known yet. Refresh the page to see where it stands before trying again.",
  unavailable: "That could not be confirmed. Refresh the page to see where it stands before trying again.",
};

// A definite refusal with no fixed sentence of its own.
export const OUTCOME_FALLBACK = "That did not go through. Nothing changed.";

export function outcomeLabel(category: string | null | undefined): string {
  return typeof category === "string" && Object.hasOwn(OUTCOME_LABELS, category)
    ? OUTCOME_LABELS[category]
    : OUTCOME_FALLBACK;
}
