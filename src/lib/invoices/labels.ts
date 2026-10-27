import { dollars } from "../money/format";
import type { MoneyActionState } from "../money/types";
import type { InvoiceReviewReason, InvoiceReviewStatus } from "../rules-engine/invoice-review";
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
  superseded: "Replaced by a newer card.",
  posted_outside: "This payment is already in QuickBooks, so it must be moved there by hand.",
  duplicate_ref: "A different payment already uses that reference.",
  over_applied: "An application is more than that invoice still owes, or more than the payment.",
  limit: "Too many payments recorded today, or the amount is over the cap.",
  validation: "That request is not valid for this record. Nothing was saved or sent.",
  attempts_used: "This was tried the most times allowed. Check QuickBooks first.",
  already_posted: "This is already posted to QuickBooks.",
  disabled: "This is off in this environment.",
  amount_mismatch: "QuickBooks holds this number at a different amount. Check it there by hand.",
  applications_changed: "This payment's invoices changed while it was being posted. Nothing was sent. Refresh the page and post again.",
  history: "Only invoices made from the invoice queue post from here. This one came from earlier records.",
  no_billing_address: "This customer has no billing address on file, so it was not posted.",
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

// The QuickBooks line on an invoice's or a payment's record page: its QuickBooks record when one
// is stored, else where its attempts to send it stand. A send nobody confirmed never reads as sent
// or as not sent, and a failed one never says whether QuickBooks holds it.
export function quickBooksStanding(qboTail: string | null, states: readonly MoneyActionState[]): string {
  if (qboTail) return `In QuickBooks, record ending ${qboTail}`;
  if (states.includes("confirmed")) return "Confirmed by QuickBooks";
  if (states.includes("unknown")) return "Not confirmed yet";
  if (states.includes("sent")) return "Sent, waiting for QuickBooks to confirm it";
  if (states.includes("reserved")) return "Waiting to send";
  if (states.includes("failed")) return "Not confirmed. The last attempt failed";
  return "Not sent yet";
}

// Why "Mark reviewed" or "Mark as sent" was refused. Anything not listed reads as the outcome
// labels do, so a lost reply still says the outcome is not known.
export const REVIEW_WRITE_LABELS: Readonly<Record<string, string>> = {
  not_posted: "Post this invoice to accounting first, then mark it as sent.",
  not_ready: "This invoice is not ready to send yet. Clear what the review shows first.",
  validation: "That is not valid for this invoice. Nothing was saved.",
  not_found: "This invoice could not be found. Refresh the page.",
};

export function reviewWriteLabel(category: string | null | undefined): string {
  return typeof category === "string" && Object.hasOwn(REVIEW_WRITE_LABELS, category)
    ? REVIEW_WRITE_LABELS[category]
    : outcomeLabel(category);
}

// The six review statuses, as the invoice screens name them.
export const REVIEW_STATUS_LABELS: Readonly<Record<InvoiceReviewStatus, string>> = {
  sync_error: "Accounting sync error",
  rate_mismatch: "Rate mismatch",
  missing_documents: "Missing documents",
  duplicate_warning: "Duplicate warning",
  needs_review: "Needs review",
  ready_to_send: "Ready to send",
};

// The Review tab's empty table. A status filter narrows the rows but never the counts, so with one
// on, an empty table says only that nothing has that status, unless the whole queue is empty.
export function reviewEmptyState(
  filter: InvoiceReviewStatus | undefined,
  queued: number,
): { title: string; body: string } {
  const clear = "Every live invoice is ready and recorded as sent.";
  if (filter === undefined) return { title: "Nothing to review", body: clear };
  return {
    title: "None with this status",
    body: queued > 0 ? "No invoice in the review queue has this status. Choose All to see the rest." : clear,
  };
}

// One short line per review reason, for a list row.
export const REVIEW_REASON_LABELS: Readonly<Record<InvoiceReviewReason, string>> = {
  posting_failed: "The post to accounting failed",
  posting_unknown: "The post to accounting is unconfirmed",
  engine_total_differs: "The load's total differs",
  rate_confirmation_differs: "The rate confirmation differs",
  posted_amount_differs: "Accounting holds another amount",
  no_delivery_document: "Signed delivery document not confirmed",
  same_amount_recent: "Same amount billed recently",
  not_reviewed: "Not reviewed yet",
  not_posted: "Not posted to accounting yet",
};

// Why a post to accounting failed, in a few plain words. Anything not listed reads as refused.
const POST_FAILURE_WORDS: Readonly<Record<string, string>> = {
  validation: "the accounting system refused it as not valid",
  duplicate: "the accounting system already has that number",
  auth: "the connection's login was refused",
  rate_limited: "too many requests at once",
  unavailable: "the accounting system was down",
  timeout: "no reply in time",
  network: "the connection dropped",
  amount_mismatch: "it holds this number at another amount",
  outside_failed: "the accounting system rejected it",
  not_connected: "accounting is not connected",
  not_configured: "accounting is not set up for this",
  disabled: "posting is off in this environment",
};

export type ReviewReasonDetail = {
  amountCents: number;
  engineTotalCents: number | null;
  engineLinehaulCents: number | null;
  ratedCents: number | null;
  qboAmountCents: number | null;
  failureCategory: string | null;
  // The invoice numbers behind a duplicate warning, oldest first.
  duplicateNumbers: readonly string[];
  // Whether the review read the load's uploaded documents (DOCUMENTS_AVAILABLE in documents.ts).
  // Until it does, a missing delivery document is unconfirmed, never "none on file".
  documentsRead: boolean;
};

const money = (cents: number | null): string => (cents === null ? "an unknown amount" : dollars(cents));

// The full sentence for one reason on an invoice's record page. Amounts come from the review's own
// inputs, so the sentence and the status never disagree.
export function reviewReasonSentence(reason: InvoiceReviewReason, d: ReviewReasonDetail): string {
  switch (reason) {
    case "posting_failed": {
      const words =
        d.failureCategory !== null && Object.hasOwn(POST_FAILURE_WORDS, d.failureCategory)
          ? POST_FAILURE_WORDS[d.failureCategory]
          : "it was refused";
      return `The post to accounting failed: ${words}.`;
    }
    case "posting_unknown":
      return "The post to accounting is unconfirmed. Check pending.";
    case "engine_total_differs":
      return `The engine's total for this load is ${money(d.engineTotalCents)}, the invoice says ${money(d.amountCents)}.`;
    case "rate_confirmation_differs":
      return `The rate confirmation says ${money(d.ratedCents)}; the load says ${money(d.engineLinehaulCents)}.`;
    case "posted_amount_differs":
      return `The accounting system holds this invoice at ${money(d.qboAmountCents)}.`;
    case "no_delivery_document":
      return d.documentsRead
        ? "This customer requires a signed delivery document; none is on file for this load."
        : "This customer requires a signed delivery document. Uploaded documents are not checked here yet, so none is confirmed for this load.";
    case "same_amount_recent":
      return `Another invoice for this customer, same amount, within two weeks: ${d.duplicateNumbers.join(", ")}.`;
    case "not_reviewed":
      return "Nobody has reviewed this yet.";
    case "not_posted":
      return "Ready here; not posted to accounting yet.";
  }
}

// The accounting line on an invoice: where it stands in the accounting system and with the customer.
// An invoice from earlier records is never posted from here, so it never reads as waiting on a post.
export function accountingLine(v: {
  posted: boolean;
  madeByQueue: boolean;
  emailStatus: string | null;
  sentOn: string | null;
  sentBy: string | null;
}): string {
  if (v.sentOn !== null) return v.sentBy ? `Sent ${v.sentOn} by ${v.sentBy}` : `Sent ${v.sentOn}`;
  if (!v.posted) return v.madeByQueue ? "Not posted to accounting yet" : "From earlier records, not posted from here";
  if (v.emailStatus === "need_to_send") return "Posted, unsent (in the accounting system's send queue)";
  if (v.emailStatus === "email_sent") return "Posted; the accounting system shows it emailed";
  return "Posted, unsent";
}
