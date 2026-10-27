import { daysBetween, type Instant, type LocalDate } from "../time/local-date";
import { assertCents } from "./money";
import {
  assertDate,
  assertId,
  assertOneOf,
  compareText,
  INVOICE_STATUSES,
  InputError,
  instantMs,
  type Cents,
  type InvoiceStatus,
  type SourceRef,
} from "./types";

// Invoice review: whether an invoice is ready to send, or what is in the way. The status is never
// stored; it is computed here every time from the invoice, its load's total by the engine, the
// customer's document rule, the documents known for the load, the customer's other invoices and
// the latest post to accounting. Pure: no clock, no database.

// In precedence order: an invoice shows the first status any of its reasons belongs to.
export const INVOICE_REVIEW_STATUSES = [
  "sync_error",
  "rate_mismatch",
  "missing_documents",
  "duplicate_warning",
  "needs_review",
  "ready_to_send",
] as const;
export type InvoiceReviewStatus = (typeof INVOICE_REVIEW_STATUSES)[number];

// Each reason, in the order it is checked, with the status it puts the invoice in. not_posted is
// a note on a ready invoice the invoice queue made (ready here, not posted to accounting yet),
// never a blocker. An invoice from earlier records never posts from here, so it never carries it.
export const INVOICE_REVIEW_REASONS = [
  "posting_failed",
  "posting_unknown",
  "engine_total_differs",
  "rate_confirmation_differs",
  "posted_amount_differs",
  "no_delivery_document",
  "same_amount_recent",
  "not_reviewed",
  "not_posted",
] as const;
export type InvoiceReviewReason = (typeof INVOICE_REVIEW_REASONS)[number];

export const REVIEW_STATUS_OF: Readonly<Record<InvoiceReviewReason, InvoiceReviewStatus>> = {
  posting_failed: "sync_error",
  posting_unknown: "sync_error",
  engine_total_differs: "rate_mismatch",
  rate_confirmation_differs: "rate_mismatch",
  posted_amount_differs: "rate_mismatch",
  no_delivery_document: "missing_documents",
  same_amount_recent: "duplicate_warning",
  not_reviewed: "needs_review",
  not_posted: "ready_to_send",
};

// Two invoices for one customer at the same amount this many days apart or closer may be the same
// bill twice.
export const DUPLICATE_WINDOW_DAYS = 14;

// The ledger states of an invoice post (money_actions). Only confirmed is settled: reserved and
// sent may or may not have reached accounting, and unknown is unknown until a read-back.
export const POSTING_STATES = ["reserved", "sent", "confirmed", "failed", "unknown"] as const;
export type PostingState = (typeof POSTING_STATES)[number];

export const DOCUMENT_KINDS = ["bill_of_lading", "rate_confirmation", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

// A document read for a load. ratedCents is the rate a rate confirmation states, when the reading
// carries one in whole cents; null otherwise.
export type DocumentFact = {
  documentId: string;
  kind: DocumentKind;
  loadId: string;
  ratedCents: Cents | null;
};

export type InvoiceReviewInput = {
  invoice: {
    id: string;
    amountCents: Cents;
    customerId: string;
    loadId: string | null;
    issuedOn: LocalDate;
    status: InvoiceStatus;
    reviewedAt: Instant | null;
    sentOn: LocalDate | null;
    qboId: string | null;
    qboAmountCents: Cents | null;
    // True when the invoice queue made it, so it posts to accounting from here before it is
    // recorded as sent. False for history (seeded, imported, opening balance): recorded by hand.
    madeByQueue: boolean;
  };
  // invoiceAmount(load).amountCents when the load has one, else null (no load, or no rate).
  engineTotalCents: Cents | null;
  // The load's linehaul, for comparing with a rate confirmation; null without a load or a rate.
  engineLinehaulCents: Cents | null;
  customer: { podRequired: boolean };
  // The documents known for the invoice's load; [] when none are known.
  documents: readonly DocumentFact[];
  // The same customer's other invoices. Void ones and this one are skipped here as well.
  siblings: readonly { id: string; amountCents: Cents; issuedOn: LocalDate; status: InvoiceStatus }[];
  // The latest invoice post in the ledger, or null when it was never posted from here.
  posting: { state: PostingState; failureCategory: string | null } | null;
};

export type InvoiceReview = {
  status: InvoiceReviewStatus;
  // Every reason that applies, in check order; the first one is the status's own.
  reasons: InvoiceReviewReason[];
  sources: SourceRef[];
  sentOn: LocalDate | null;
  // The sibling invoices behind same_amount_recent, oldest first.
  duplicateOf: string[];
};

function checkInput(input: InvoiceReviewInput): void {
  const inv = input.invoice;
  assertId(inv.id, "invoice id");
  assertCents(inv.amountCents, `invoice ${inv.id} amount`);
  assertId(inv.customerId, `invoice ${inv.id} customer`);
  if (inv.loadId !== null) assertId(inv.loadId, `invoice ${inv.id} load`);
  assertDate(inv.issuedOn, `invoice ${inv.id} issued date`);
  assertOneOf(inv.status, INVOICE_STATUSES, `invoice ${inv.id} status`);
  if (inv.reviewedAt !== null) instantMs(inv.reviewedAt, `invoice ${inv.id} reviewed time`);
  if (inv.sentOn !== null) assertDate(inv.sentOn, `invoice ${inv.id} sent date`);
  if (inv.qboAmountCents !== null) assertCents(inv.qboAmountCents, `invoice ${inv.id} posted amount`);
  if (typeof inv.madeByQueue !== "boolean") throw new InputError(`invoice ${inv.id} origin is missing`);
  if (input.engineTotalCents !== null) assertCents(input.engineTotalCents, `invoice ${inv.id} engine total`);
  if (input.engineLinehaulCents !== null) {
    assertCents(input.engineLinehaulCents, `invoice ${inv.id} linehaul`);
  }
  if (typeof input.customer?.podRequired !== "boolean") {
    throw new InputError(`invoice ${inv.id} customer document rule is missing`);
  }
  for (const d of input.documents) {
    assertId(d.documentId, "document id");
    assertOneOf(d.kind, DOCUMENT_KINDS, `document ${d.documentId} kind`);
    assertId(d.loadId, `document ${d.documentId} load`);
    if (d.ratedCents !== null) assertCents(d.ratedCents, `document ${d.documentId} rate`);
  }
  for (const s of input.siblings) {
    assertId(s.id, "sibling invoice id");
    assertCents(s.amountCents, `invoice ${s.id} amount`);
    assertDate(s.issuedOn, `invoice ${s.id} issued date`);
    assertOneOf(s.status, INVOICE_STATUSES, `invoice ${s.id} status`);
  }
  if (input.posting !== null) {
    assertOneOf(input.posting.state, POSTING_STATES, `invoice ${inv.id} posting state`);
  }
}

// The rate confirmations on the invoice's load whose rated amount differs from the load's linehaul,
// compared whole. The status and the sentence that explains it both read this one list, so the
// amount a sentence quotes is always one that differs.
export function differingRateConfirmations(input: InvoiceReviewInput): DocumentFact[] {
  const linehaul = input.engineLinehaulCents;
  if (linehaul === null) return [];
  return input.documents.filter(
    (d) =>
      d.kind === "rate_confirmation" &&
      d.loadId === input.invoice.loadId &&
      d.ratedCents !== null &&
      d.ratedCents !== linehaul,
  );
}

export function reviewInvoice(input: InvoiceReviewInput): InvoiceReview {
  checkInput(input);
  const inv = input.invoice;
  const self: SourceRef = { table: "invoices", id: inv.id };
  // A paid or void invoice is settled business: never reviewed, never in the review queue.
  if (inv.status === "paid" || inv.status === "void") {
    return { status: "ready_to_send", reasons: [], sources: [self], sentOn: inv.sentOn, duplicateOf: [] };
  }
  const reasons: InvoiceReviewReason[] = [];
  const sources: SourceRef[] = [self];
  const addSource = (ref: SourceRef) => {
    if (!sources.some((s) => s.table === ref.table && s.id === ref.id)) sources.push(ref);
  };
  const load: SourceRef | null = inv.loadId === null ? null : { table: "loads", id: inv.loadId };

  // Accounting sync. Only a confirmed post is settled; everything short of it is unknown until a
  // read-back says otherwise, never a failure and never a success.
  if (input.posting !== null) {
    if (input.posting.state === "failed") reasons.push("posting_failed");
    else if (input.posting.state !== "confirmed") reasons.push("posting_unknown");
  }

  // Amounts. Whole values only.
  if (input.engineTotalCents !== null && input.engineTotalCents !== inv.amountCents) {
    reasons.push("engine_total_differs");
    if (load) addSource(load);
  }
  if (differingRateConfirmations(input).length > 0) {
    reasons.push("rate_confirmation_differs");
    if (load) addSource(load);
  }
  if (inv.qboAmountCents !== null && inv.qboAmountCents !== inv.amountCents) {
    reasons.push("posted_amount_differs");
  }

  // Documents: only for a load invoice of a customer that requires one, and only until it is sent.
  if (input.customer.podRequired && inv.loadId !== null && inv.sentOn === null) {
    const bol = input.documents.some((d) => d.kind === "bill_of_lading" && d.loadId === inv.loadId);
    if (!bol) {
      reasons.push("no_delivery_document");
      if (load) addSource(load);
    }
  }

  // A possible duplicate: same customer, same amount, issued within the window, not void. A
  // person's review settles it, so it is raised only until someone has reviewed the invoice.
  const duplicateOf =
    inv.reviewedAt !== null
      ? []
      : input.siblings
          .filter(
            (s) =>
              s.id !== inv.id &&
              s.status !== "void" &&
              s.amountCents === inv.amountCents &&
              Math.abs(daysBetween(s.issuedOn, inv.issuedOn)) <= DUPLICATE_WINDOW_DAYS,
          )
          .sort((a, b) => compareText(a.issuedOn, b.issuedOn) || compareText(a.id, b.id))
          .map((s) => s.id);
  if (duplicateOf.length > 0) {
    reasons.push("same_amount_recent");
    for (const id of duplicateOf) addSource({ table: "invoices", id });
  }

  if (inv.reviewedAt === null) reasons.push("not_reviewed");
  if (reasons.length === 0 && inv.qboId === null && inv.madeByQueue) reasons.push("not_posted");

  const first = reasons[0];
  const status: InvoiceReviewStatus = first === undefined ? "ready_to_send" : REVIEW_STATUS_OF[first];
  return { status, reasons, sources, sentOn: inv.sentOn, duplicateOf };
}

// The review queue shows a live invoice until it is ready and recorded as sent.
export function inReviewQueue(status: InvoiceStatus, review: InvoiceReview): boolean {
  if (status !== "open" && status !== "partially_paid") return false;
  return !(review.status === "ready_to_send" && review.sentOn !== null);
}
