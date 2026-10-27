import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readReviewQueue } from "../../../../invoices/review-read";
import { INVOICE_REVIEW_STATUSES } from "../../../../rules-engine";
import { defineTool, type GatewayRef } from "../../types";
import { OPERATOR_AUDITOR } from "../shared";

const isOn = () => flags.invoicesEnabled && flags.invoiceReviewEnabled;

// At most this many rows per answer; counts always cover the whole queue.
export const REVIEW_QUEUE_ROWS = 50;

export const getInvoiceReviewQueue = defineTool({
  name: "get_invoice_review_queue",
  description:
    "List the invoice review queue: live invoices not yet ready and recorded as sent, worst status " +
    "first (sync_error, rate_mismatch, missing_documents, duplicate_warning, needs_review, " +
    "ready_to_send), optionally one status only. counts are per status over the whole queue; rows " +
    "are at most 50, each with its first reason. Money is in integer cents. This only reads.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading the invoice review queue",
  enabled: isOn,
  args: z.strictObject({ status: z.enum(INVOICE_REVIEW_STATUSES).optional() }),
  refs: (): GatewayRef[] => [],
  run: async (q, _ctx, a) => {
    if (!isOn()) throw new Error("invoice review is switched off");
    const queue = await readReviewQueue(q, a.status);
    return {
      result: {
        counts: queue.counts,
        truncated: queue.rows.length > REVIEW_QUEUE_ROWS,
        rows: queue.rows.slice(0, REVIEW_QUEUE_ROWS).map((r) => ({
          invoiceId: r.id,
          invoiceNumber: r.invoiceNumber,
          customerId: r.customerId,
          loadId: r.loadId,
          amountCents: r.amountCents,
          issuedOn: r.issuedOn,
          status: r.status,
          firstReason: r.firstReason,
          sentOn: r.sentOn,
        })),
      },
    };
  },
});
