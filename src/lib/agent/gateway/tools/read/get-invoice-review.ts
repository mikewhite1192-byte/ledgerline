import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readInvoiceReview } from "../../../../invoices/review-read";
import { defineTool } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

const isOn = () => flags.invoicesEnabled && flags.invoiceReviewEnabled;

export const getInvoiceReview = defineTool({
  name: "get_invoice_review",
  description:
    "Read one invoice's review: its status (sync_error, rate_mismatch, missing_documents, " +
    "duplicate_warning, needs_review, ready_to_send), every reason in check order with its " +
    "sentence, the records behind them, and where it stands in accounting (posted, unsent, sent " +
    "date). The status is computed by the rules engine; money is in integer cents. This only " +
    "reads: a person marks an invoice reviewed or sent.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading an invoice's review",
  enabled: isOn,
  args: z.strictObject({ invoiceId: idField() }),
  refs: (a) => [{ table: "invoices", id: a.invoiceId }],
  run: async (q, _ctx, a) => {
    if (!isOn()) throw new Error("invoice review is switched off");
    const v = await readInvoiceReview(q, a.invoiceId);
    if (!v) throw new Error("invoice not found");
    return {
      result: {
        invoiceId: v.invoiceId,
        invoiceNumber: v.invoiceNumber,
        invoiceStatus: v.invoiceStatus,
        customerId: v.customerId,
        loadId: v.loadId,
        amountCents: v.amountCents,
        issuedOn: v.issuedOn,
        status: v.review.status,
        reasons: v.reasons.map((r) => ({ reason: r.reason, sentence: r.sentence })),
        sources: v.review.sources,
        duplicateOf: v.duplicates,
        inReviewQueue: v.inQueue,
        posted: v.posted,
        accountingEmailStatus: v.emailStatus,
        postedAmountCents: v.qboAmountCents,
        reviewed: v.reviewedAt !== null,
        sentOn: v.sentOn,
      },
    };
  },
});
