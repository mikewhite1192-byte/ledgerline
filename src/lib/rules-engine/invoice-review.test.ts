import { describe, expect, it } from "vitest";
import {
  differingRateConfirmations,
  DUPLICATE_WINDOW_DAYS,
  INVOICE_REVIEW_REASONS,
  INVOICE_REVIEW_STATUSES,
  inReviewQueue,
  REVIEW_STATUS_OF,
  reviewInvoice,
  type DocumentFact,
  type InvoiceReviewInput,
} from "./invoice-review";
import { c } from "./test-records";
import { InputError } from "./types";

type Over = Partial<Omit<InvoiceReviewInput, "invoice">> & {
  invoice?: Partial<InvoiceReviewInput["invoice"]>;
};

// A posted, reviewed, unsent load invoice of 1,250.00 whose engine total agrees: ready to send.
function input(over: Over = {}): InvoiceReviewInput {
  const { invoice, ...rest } = over;
  return {
    invoice: {
      id: "inv-a",
      amountCents: c(125_000),
      customerId: "cust-a",
      loadId: "load-a",
      issuedOn: "2026-10-20",
      status: "open",
      reviewedAt: "2026-10-21T15:00:00.000Z",
      sentOn: null,
      qboId: "901",
      qboAmountCents: c(125_000),
      madeByQueue: true,
      ...invoice,
    },
    engineTotalCents: c(125_000),
    engineLinehaulCents: c(110_000),
    customer: { podRequired: false },
    documents: [],
    siblings: [],
    posting: { state: "confirmed", failureCategory: null },
    ...rest,
  };
}

const bol = (loadId = "load-a"): DocumentFact => ({
  documentId: "doc-1",
  kind: "bill_of_lading",
  loadId,
  ratedCents: null,
});
const sibling = (issuedOn: string, amount = 125_000, status: "open" | "void" | "paid" = "open") => ({
  id: `inv-${issuedOn}`,
  amountCents: c(amount),
  issuedOn,
  status,
});

describe("reviewInvoice: one case per rule", () => {
  it("is ready to send when nothing is in the way", () => {
    const r = reviewInvoice(input());
    expect(r).toEqual({
      status: "ready_to_send",
      reasons: [],
      sources: [{ table: "invoices", id: "inv-a" }],
      sentOn: null,
      duplicateOf: [],
    });
  });

  it("notes not_posted on a ready invoice with no accounting id, still ready", () => {
    const r = reviewInvoice(input({ invoice: { qboId: null, qboAmountCents: null }, posting: null }));
    expect(r.status).toBe("ready_to_send");
    expect(r.reasons).toEqual(["not_posted"]);
  });

  it("never notes not_posted on an invoice from earlier records, which is never posted from here", () => {
    const r = reviewInvoice(
      input({ invoice: { qboId: null, qboAmountCents: null, madeByQueue: false }, posting: null }),
    );
    expect(r).toMatchObject({ status: "ready_to_send", reasons: [] });
    // Everything else reads the same: an unreviewed one still needs review.
    const unreviewed = reviewInvoice(
      input({ invoice: { qboId: null, qboAmountCents: null, madeByQueue: false, reviewedAt: null }, posting: null }),
    );
    expect(unreviewed).toMatchObject({ status: "needs_review", reasons: ["not_reviewed"] });
  });

  it("a failed post is a sync error", () => {
    const r = reviewInvoice(input({ posting: { state: "failed", failureCategory: "validation" } }));
    expect(r.status).toBe("sync_error");
    expect(r.reasons).toEqual(["posting_failed"]);
  });

  it.each(["sent", "unknown", "reserved"] as const)("a %s post is unknown, never failed", (state) => {
    const r = reviewInvoice(input({ posting: { state, failureCategory: null } }));
    expect(r.status).toBe("sync_error");
    expect(r.reasons).toEqual(["posting_unknown"]);
  });

  it("an engine total that differs is a rate mismatch pointing at the load", () => {
    const r = reviewInvoice(input({ engineTotalCents: c(140_000) }));
    expect(r.status).toBe("rate_mismatch");
    expect(r.reasons).toEqual(["engine_total_differs"]);
    expect(r.sources).toContainEqual({ table: "loads", id: "load-a" });
  });

  it("a load with no engine total (no rate) never raises engine_total_differs", () => {
    expect(reviewInvoice(input({ engineTotalCents: null })).status).toBe("ready_to_send");
  });

  it("a rate confirmation that differs from the linehaul is a rate mismatch", () => {
    const doc: DocumentFact = { documentId: "d2", kind: "rate_confirmation", loadId: "load-a", ratedCents: c(100_000) };
    const r = reviewInvoice(input({ documents: [doc] }));
    expect(r.status).toBe("rate_mismatch");
    expect(r.reasons).toEqual(["rate_confirmation_differs"]);
  });

  it("a rate confirmation that agrees, or carries no rate, or is for another load, is fine", () => {
    const agree: DocumentFact = { documentId: "d2", kind: "rate_confirmation", loadId: "load-a", ratedCents: c(110_000) };
    const none: DocumentFact = { ...agree, documentId: "d3", ratedCents: null };
    const other: DocumentFact = { ...agree, documentId: "d4", loadId: "load-b", ratedCents: c(1) };
    expect(reviewInvoice(input({ documents: [agree, none, other] })).status).toBe("ready_to_send");
    expect(reviewInvoice(input({ documents: [{ ...agree, ratedCents: c(1) }], engineLinehaulCents: null })).status)
      .toBe("ready_to_send");
  });

  it("lists only the rate confirmations that differ, the same ones the status reads", () => {
    const agree: DocumentFact = { documentId: "d6", kind: "rate_confirmation", loadId: "load-a", ratedCents: c(110_000) };
    const differs: DocumentFact = { ...agree, documentId: "d7", ratedCents: c(112_500) };
    const none: DocumentFact = { ...agree, documentId: "d8", ratedCents: null };
    const other: DocumentFact = { ...agree, documentId: "d9", loadId: "load-b", ratedCents: c(1) };
    // The agreeing one comes first, so a sentence that took the first rated one would quote the load's own rate.
    const both = input({ documents: [agree, none, other, differs] });
    expect(differingRateConfirmations(both)).toEqual([differs]);
    expect(reviewInvoice(both).reasons).toEqual(["rate_confirmation_differs"]);
    expect(differingRateConfirmations(input({ documents: [agree, none, other] }))).toEqual([]);
    expect(differingRateConfirmations(input({ documents: [differs], engineLinehaulCents: null }))).toEqual([]);
  });

  it("an amount the accounting system holds differently is a rate mismatch", () => {
    const r = reviewInvoice(input({ invoice: { qboAmountCents: c(124_999) } }));
    expect(r.status).toBe("rate_mismatch");
    expect(r.reasons).toEqual(["posted_amount_differs"]);
  });

  it("a customer that requires a delivery document, with none known, is missing documents", () => {
    const r = reviewInvoice(input({ customer: { podRequired: true } }));
    expect(r.status).toBe("missing_documents");
    expect(r.reasons).toEqual(["no_delivery_document"]);
    expect(r.sources).toContainEqual({ table: "loads", id: "load-a" });
  });

  it("a bill of lading on this load clears it; one on another load does not", () => {
    expect(reviewInvoice(input({ customer: { podRequired: true }, documents: [bol()] })).status).toBe("ready_to_send");
    expect(reviewInvoice(input({ customer: { podRequired: true }, documents: [bol("load-b")] })).status)
      .toBe("missing_documents");
  });

  it("a rate confirmation is not a delivery document", () => {
    const rc: DocumentFact = { documentId: "d5", kind: "rate_confirmation", loadId: "load-a", ratedCents: null };
    expect(reviewInvoice(input({ customer: { podRequired: true }, documents: [rc] })).status).toBe("missing_documents");
  });

  it("documents are not asked of an opening invoice or of one already sent", () => {
    const opening = input({ customer: { podRequired: true }, invoice: { loadId: null }, engineTotalCents: null });
    expect(reviewInvoice(opening).status).toBe("ready_to_send");
    const sent = input({ customer: { podRequired: true }, invoice: { sentOn: "2026-10-22" } });
    expect(reviewInvoice(sent)).toMatchObject({ status: "ready_to_send", sentOn: "2026-10-22" });
  });

  it("a same-amount sibling within the window is a duplicate warning while unreviewed", () => {
    const r = reviewInvoice(input({ invoice: { reviewedAt: null }, siblings: [sibling("2026-10-17")] }));
    expect(r.status).toBe("duplicate_warning");
    expect(r.reasons).toEqual(["same_amount_recent", "not_reviewed"]);
    expect(r.duplicateOf).toEqual(["inv-2026-10-17"]);
    expect(r.sources).toContainEqual({ table: "invoices", id: "inv-2026-10-17" });
  });

  it("a review settles a duplicate warning", () => {
    expect(reviewInvoice(input({ siblings: [sibling("2026-10-17")] })).status).toBe("ready_to_send");
  });

  it("the window holds on both edges, before and after", () => {
    const at = (d: string) =>
      reviewInvoice(input({ invoice: { reviewedAt: null }, siblings: [sibling(d)] })).status;
    expect(DUPLICATE_WINDOW_DAYS).toBe(14);
    expect(at("2026-10-06")).toBe("duplicate_warning");
    expect(at("2026-10-05")).toBe("needs_review");
    expect(at("2026-11-03")).toBe("duplicate_warning");
    expect(at("2026-11-04")).toBe("needs_review");
  });

  it("a void sibling never counts; a paid one does; a different amount does not; itself does not", () => {
    const at = (s: ReturnType<typeof sibling>) =>
      reviewInvoice(input({ invoice: { reviewedAt: null }, siblings: [s] })).status;
    expect(at(sibling("2026-10-18", 125_000, "void"))).toBe("needs_review");
    expect(at(sibling("2026-10-18", 125_000, "paid"))).toBe("duplicate_warning");
    expect(at(sibling("2026-10-18", 125_001))).toBe("needs_review");
    expect(at({ ...sibling("2026-10-20"), id: "inv-a" })).toBe("needs_review");
  });

  it("amounts compare whole, never by digits", () => {
    const r = reviewInvoice(input({ invoice: { reviewedAt: null }, siblings: [sibling("2026-10-18", 12_500)] }));
    expect(r.status).toBe("needs_review");
  });

  it("an unreviewed invoice needs review", () => {
    const r = reviewInvoice(input({ invoice: { reviewedAt: null } }));
    expect(r.status).toBe("needs_review");
    expect(r.reasons).toEqual(["not_reviewed"]);
  });

  it("a paid or void invoice is never reviewed and carries no reasons", () => {
    for (const status of ["paid", "void"] as const) {
      const r = reviewInvoice(
        input({
          invoice: { status, reviewedAt: null, qboId: null, qboAmountCents: null },
          engineTotalCents: c(1),
          customer: { podRequired: true },
          posting: { state: "failed", failureCategory: "validation" },
        }),
      );
      expect(r).toMatchObject({ status: "ready_to_send", reasons: [] });
    }
  });

  it("a partially paid invoice is still reviewed", () => {
    expect(reviewInvoice(input({ invoice: { status: "partially_paid", reviewedAt: null } })).status).toBe(
      "needs_review",
    );
  });
});

describe("reviewInvoice: precedence", () => {
  const everything: Over = {
    invoice: { reviewedAt: null, qboAmountCents: c(1) },
    posting: { state: "failed", failureCategory: "validation" },
    engineTotalCents: c(2),
    customer: { podRequired: true },
    siblings: [sibling("2026-10-19")],
  };
  it("lists every reason in check order and takes the first one's status", () => {
    const r = reviewInvoice(input(everything));
    expect(r.status).toBe("sync_error");
    expect(r.reasons).toEqual([
      "posting_failed",
      "engine_total_differs",
      "posted_amount_differs",
      "no_delivery_document",
      "same_amount_recent",
      "not_reviewed",
    ]);
  });

  // Each status beats every status after it.
  const pairs: [string, Over, string][] = [
    ["sync_error over rate_mismatch", { posting: { state: "unknown", failureCategory: null }, engineTotalCents: c(1) }, "sync_error"],
    ["rate_mismatch over missing_documents", { engineTotalCents: c(1), customer: { podRequired: true } }, "rate_mismatch"],
    ["missing_documents over duplicate_warning", { customer: { podRequired: true }, invoice: { reviewedAt: null }, siblings: [sibling("2026-10-19")] }, "missing_documents"],
    ["duplicate_warning over needs_review", { invoice: { reviewedAt: null }, siblings: [sibling("2026-10-19")] }, "duplicate_warning"],
    ["needs_review over ready_to_send", { invoice: { reviewedAt: null } }, "needs_review"],
  ];
  it.each(pairs)("%s", (_name, over, status) => {
    expect(reviewInvoice(input(over)).status).toBe(status);
  });

  it("not_posted never appears beside another reason", () => {
    const r = reviewInvoice(input({ invoice: { reviewedAt: null, qboId: null, qboAmountCents: null }, posting: null }));
    expect(r.reasons).toEqual(["not_reviewed"]);
  });

  it("every reason maps to a known status", () => {
    for (const reason of INVOICE_REVIEW_REASONS) {
      expect(INVOICE_REVIEW_STATUSES).toContain(REVIEW_STATUS_OF[reason]);
    }
  });
});

describe("reviewInvoice: refuses bad input", () => {
  it.each<[string, Over]>([
    ["amount", { invoice: { amountCents: 1.5 as never } }],
    ["status", { invoice: { status: "draft" as never } }],
    ["issued date", { invoice: { issuedOn: "10/20/2026" } }],
    ["reviewed time", { invoice: { reviewedAt: "yesterday" } }],
    ["posting state", { posting: { state: "done" as never, failureCategory: null } }],
    ["document kind", { documents: [{ documentId: "d", kind: "pod" as never, loadId: "load-a", ratedCents: null }] }],
    ["sibling amount", { siblings: [{ ...sibling("2026-10-19"), amountCents: -1 as never }] }],
    ["document rule", { customer: { podRequired: "yes" as never } }],
    ["origin", { invoice: { madeByQueue: undefined as never } }],
  ])("a bad %s", (_name, over) => {
    expect(() => reviewInvoice(input(over))).toThrow(InputError);
  });
});

describe("inReviewQueue", () => {
  it("holds live invoices until they are ready and sent", () => {
    const ready = reviewInvoice(input());
    expect(inReviewQueue("open", ready)).toBe(true);
    const sent = reviewInvoice(input({ invoice: { sentOn: "2026-10-22" } }));
    expect(inReviewQueue("open", sent)).toBe(false);
    expect(inReviewQueue("partially_paid", reviewInvoice(input({ invoice: { reviewedAt: null } })))).toBe(true);
    expect(inReviewQueue("paid", ready)).toBe(false);
    expect(inReviewQueue("void", ready)).toBe(false);
  });

  it("keeps a sent invoice whose amounts disagree", () => {
    const r = reviewInvoice(input({ invoice: { sentOn: "2026-10-22", qboAmountCents: c(1) } }));
    expect(inReviewQueue("open", r)).toBe(true);
  });
});
