import type { Queryable } from "../db";
import { loadsOf } from "../data/records";
import { readRowsWhereId, readTable } from "../data/read";
import type { InvoiceRow } from "../data/rows";
import { isCanonicalUuid } from "../money/keys";
import { readByKind, readBySubject } from "../money/read";
import {
  compareText,
  inReviewQueue,
  INVOICE_REVIEW_STATUSES,
  reviewInvoice,
  type InvoiceReview,
  type InvoiceReviewReason,
  type InvoiceReviewStatus,
} from "../rules-engine";
import { readDocumentFacts } from "./documents";
import {
  REVIEW_REASON_LABELS,
  REVIEW_STATUS_LABELS,
  reviewReasonSentence,
} from "./labels";
import { latestPostings, reviewFactsOf, reviewInputOf, type PostingFact, type ReviewFacts } from "./review-input";

// The invoice review as the pages and the agent read it, inside the request's tenant transaction.
// Read only: the status is the rules engine's answer on the rows read here, never a stored value.
// A missing invoice is null; a failed read throws (the page shows the error, never "ready").

export type ReviewReasonView = { reason: InvoiceReviewReason; label: string; sentence: string };

export type InvoiceReviewView = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: InvoiceRow["status"];
  customerId: string;
  loadId: string | null;
  amountCents: number;
  issuedOn: string;
  review: InvoiceReview;
  statusLabel: string;
  reasons: ReviewReasonView[];
  inQueue: boolean;
  posted: boolean;
  emailStatus: InvoiceRow["qbo_email_status"];
  qboAmountCents: number | null;
  reviewedAt: string | null;
  reviewedByMembershipId: string | null;
  reviewNote: string | null;
  sentOn: string | null;
  sentByMembershipId: string | null;
  // The invoices behind a duplicate warning, oldest first.
  duplicates: { id: string; invoiceNumber: string }[];
  posting: PostingFact | null;
  podRequired: boolean;
};

export type ReviewQueueRow = {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  loadId: string | null;
  amountCents: number;
  issuedOn: string;
  status: InvoiceReviewStatus;
  statusLabel: string;
  firstReason: InvoiceReviewReason | null;
  firstReasonLabel: string | null;
  posted: boolean;
  emailStatus: InvoiceRow["qbo_email_status"];
  sentOn: string | null;
};

export type ReviewQueue = {
  counts: Record<InvoiceReviewStatus, number>;
  rows: ReviewQueueRow[];
};

function viewOf(inv: InvoiceRow, facts: ReviewFacts, numbers: ReadonlyMap<string, string>): InvoiceReviewView {
  const input = reviewInputOf(inv, facts);
  const review = reviewInvoice(input);
  const posting = input.posting;
  const ratedCents =
    input.documents.find((d) => d.kind === "rate_confirmation" && d.ratedCents !== null)?.ratedCents ?? null;
  const duplicates = review.duplicateOf.map((id) => ({ id, invoiceNumber: numbers.get(id) ?? "" }));
  const detail = {
    amountCents: input.invoice.amountCents,
    engineTotalCents: input.engineTotalCents,
    engineLinehaulCents: input.engineLinehaulCents,
    ratedCents,
    qboAmountCents: input.invoice.qboAmountCents,
    failureCategory: posting?.failureCategory ?? null,
    duplicateNumbers: duplicates.map((d) => d.invoiceNumber),
  };
  return {
    invoiceId: inv.id,
    invoiceNumber: inv.invoice_number,
    invoiceStatus: inv.status,
    customerId: inv.customer_id,
    loadId: inv.load_id,
    amountCents: input.invoice.amountCents,
    issuedOn: inv.issued_on,
    review,
    statusLabel: REVIEW_STATUS_LABELS[review.status],
    reasons: review.reasons.map((reason) => ({
      reason,
      label: REVIEW_REASON_LABELS[reason],
      sentence: reviewReasonSentence(reason, detail),
    })),
    inQueue: inReviewQueue(inv.status, review),
    posted: inv.qbo_id !== null,
    emailStatus: inv.qbo_email_status,
    qboAmountCents: input.invoice.qboAmountCents,
    reviewedAt: inv.reviewed_at,
    reviewedByMembershipId: inv.reviewed_by_membership_id,
    reviewNote: inv.review_note,
    sentOn: inv.sent_on,
    sentByMembershipId: inv.sent_by_membership_id,
    duplicates,
    posting,
    podRequired: input.customer.podRequired,
  };
}

// One invoice's review, from its own rows: the invoice, its customer and the customer's other
// invoices, its load, the load's documents and this invoice's ledger rows.
export async function readInvoiceReview(q: Queryable, invoiceId: string): Promise<InvoiceReviewView | null> {
  const [inv] = await readRowsWhereId(q, "invoices", "id", invoiceId);
  if (!inv) return null;
  const customers = await readRowsWhereId(q, "customers", "id", inv.customer_id);
  const siblings = await readRowsWhereId(q, "invoices", "customer_id", inv.customer_id);
  let loads: ReturnType<typeof loadsOf> = [];
  if (inv.load_id !== null) {
    const loadRows = await readRowsWhereId(q, "loads", "id", inv.load_id);
    const miles = await readRowsWhereId(q, "load_state_miles", "load_id", inv.load_id);
    const extras = await readRowsWhereId(q, "load_accessorials", "load_id", inv.load_id);
    loads = loadsOf(loadRows, miles, extras);
  }
  const facts = reviewFactsOf({
    invoices: siblings,
    customers,
    loads,
    documents: await readDocumentFacts(q, inv.load_id === null ? [] : [inv.load_id]),
    postings: latestPostings(await readBySubject(q, "invoices", inv.id)),
  });
  return viewOf(inv, facts, new Map(siblings.map((s) => [s.id, s.invoice_number])));
}

const emptyCounts = (): Record<InvoiceReviewStatus, number> =>
  Object.fromEntries(INVOICE_REVIEW_STATUSES.map((s) => [s, 0])) as Record<InvoiceReviewStatus, number>;

// The review queue: every live invoice that is not yet ready and recorded as sent, worst status
// first (the engine's precedence), then newest issued. Counts are per status over the whole queue;
// rows are filtered to one status when one is given.
export async function readReviewQueue(q: Queryable, status?: InvoiceReviewStatus): Promise<ReviewQueue> {
  const invoices = await readTable(q, "invoices");
  const customers = await readTable(q, "customers");
  const loads = loadsOf(
    await readTable(q, "loads"),
    await readTable(q, "load_state_miles"),
    await readTable(q, "load_accessorials"),
  );
  const live = invoices.filter((i) => i.status === "open" || i.status === "partially_paid");
  const loadIds = [...new Set(live.flatMap((i) => (i.load_id === null ? [] : [i.load_id])))];
  const facts = reviewFactsOf({
    invoices,
    customers,
    loads,
    documents: await readDocumentFacts(q, loadIds),
    postings: latestPostings(await readByKind(q, "invoice")),
  });
  const names = new Map(customers.map((c) => [c.id, c.name]));
  const numbers = new Map(invoices.map((i) => [i.id, i.invoice_number]));
  const counts = emptyCounts();
  const rows: ReviewQueueRow[] = [];
  for (const inv of live) {
    const v = viewOf(inv, facts, numbers);
    if (!v.inQueue) continue;
    counts[v.review.status] += 1;
    if (status !== undefined && v.review.status !== status) continue;
    const first = v.review.reasons[0] ?? null;
    rows.push({
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      customerId: inv.customer_id,
      customerName: names.get(inv.customer_id) ?? "",
      loadId: inv.load_id,
      amountCents: v.amountCents,
      issuedOn: inv.issued_on,
      status: v.review.status,
      statusLabel: v.statusLabel,
      firstReason: first,
      firstReasonLabel: first === null ? null : REVIEW_REASON_LABELS[first],
      posted: v.posted,
      emailStatus: v.emailStatus,
      sentOn: v.sentOn,
    });
  }
  const rank = (s: InvoiceReviewStatus) => INVOICE_REVIEW_STATUSES.indexOf(s);
  rows.sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      compareText(b.issuedOn, a.issuedOn) ||
      compareText(a.invoiceNumber, b.invoiceNumber),
  );
  return { counts, rows };
}

// Who reviewed or recorded a send, as a role word only: no names or addresses on the page. At most
// two ids, one statement each.
export async function readMemberRoles(
  q: Queryable,
  ids: readonly (string | null)[],
): Promise<Map<string, "admin" | "staff">> {
  const out = new Map<string, "admin" | "staff">();
  for (const id of new Set(ids)) {
    if (id === null || !isCanonicalUuid(id)) continue;
    const [r] = await q.query<{ role: string }>(
      "SELECT role FROM memberships WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [id],
    );
    if (r && (r.role === "admin" || r.role === "staff")) out.set(id, r.role);
  }
  return out;
}
