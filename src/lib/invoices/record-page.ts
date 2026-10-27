import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import type { LocalDate } from "../time/local-date";
import { madeByQueue } from "./made-by-queue";
import { datedBeforeInvoicesStart } from "./post";
import { readInvoiceReview, readMemberRoles, type InvoiceReviewView } from "./review-read";
import { readInvoiceRecord, type InvoiceRecordView } from "./views";

// One invoice's record page, read inside the request's tenant transaction, and the buttons it
// offers. Read only.

export type InvoiceRecordPage = {
  record: InvoiceRecordView;
  review: { view: InvoiceReviewView; roles: Map<string, string> } | null;
  // made-by-queue.ts's answer: the review's own when the review is read, else the same rule
  // asked for this one invoice.
  queueMade: boolean;
};

// The record, and its review while the review switch is on (off, the review is never read).
export async function readInvoiceRecordPage(
  q: Queryable,
  id: string,
  today: LocalDate,
): Promise<InvoiceRecordPage | null> {
  const record = await readInvoiceRecord(q, id, today);
  if (!record) return null;
  if (!(flags.invoicesEnabled && flags.invoiceReviewEnabled)) {
    const queueMade = await madeByQueue(q, { source: record.source, load_id: record.loadId });
    return { record, review: null, queueMade };
  }
  const view = await readInvoiceReview(q, id);
  if (!view) return null;
  const roles = await readMemberRoles(q, [view.reviewedByMembershipId, view.sentByMembershipId]);
  return { record, review: { view, roles }, queueMade: view.madeByQueue };
}

export type InvoiceRecordActions = { post: boolean; check: boolean };

// "Post to QuickBooks" shows until a post is confirmed, and only for an invoice the queue made on
// or after the invoices start: anything else is history, and its post is refused (post.ts).
// While the Review card is on a post that needs a retry or a check, its buttons are the ones.
export function invoiceRecordActions(page: InvoiceRecordPage): InvoiceRecordActions {
  const inv = page.record;
  const cardActs = page.review !== null && page.review.view.review.status === "sync_error";
  const confirmed = inv.posted || inv.ledger.some((r) => r.state === "confirmed");
  const post =
    flags.invoicesEnabled &&
    !confirmed &&
    inv.status !== "void" &&
    !cardActs &&
    page.queueMade &&
    !datedBeforeInvoicesStart(inv.issuedOn);
  // A post nobody confirmed yet (unknown, or sent with no answer) is read back from here.
  const check =
    flags.invoicesEnabled &&
    !confirmed &&
    !cardActs &&
    inv.ledger.some((r) => r.state === "unknown" || r.state === "sent");
  return { post, check };
}
