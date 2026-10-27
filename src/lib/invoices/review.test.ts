import { describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { InvoiceRow } from "../data/rows";
import {
  cents,
  INVOICE_REVIEW_REASONS,
  INVOICE_REVIEW_STATUSES,
  InputError,
  reviewInvoice,
  type LoadRecord,
} from "../rules-engine";
import { addDays } from "../time/local-date";
import {
  accountingLine,
  OUTCOME_FALLBACK,
  OUTCOME_LABELS,
  REVIEW_REASON_LABELS,
  REVIEW_STATUS_LABELS,
  reviewReasonSentence,
  reviewWriteLabel,
  type ReviewReasonDetail,
} from "./labels";
import { latestPostings, reviewFactsOf, reviewInputOf } from "./review-input";

// The review's words and the pure step that turns rows into the engine's input.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CUSTOMER = id(1);
const LOAD = id(2);
const INVOICE = id(3);

const detail = (over: Partial<ReviewReasonDetail> = {}): ReviewReasonDetail => ({
  amountCents: 150_000,
  engineTotalCents: 165_000,
  engineLinehaulCents: 140_000,
  ratedCents: 145_000,
  qboAmountCents: 151_000,
  failureCategory: null,
  duplicateNumbers: ["X-INV-1", "X-INV-2"],
  ...over,
});

const invoice = (over: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: INVOICE,
  invoice_number: "X-INV-3",
  customer_id: CUSTOMER,
  load_id: LOAD,
  source: "load",
  issued_on: "2026-10-20",
  due_on: "2026-11-19",
  amount_cents: 165_000,
  status: "open",
  paid_on: null,
  qbo_id: null,
  reviewed_at: null,
  reviewed_by_membership_id: null,
  review_note: null,
  sent_on: null,
  sent_by_membership_id: null,
  qbo_email_status: null,
  qbo_amount_cents: null,
  ...over,
});

const load = (over: Partial<LoadRecord> = {}): LoadRecord => ({
  id: LOAD,
  loadNumber: "X-L1",
  customerId: CUSTOMER,
  driverId: id(6),
  status: "delivered",
  originCity: "Springfield",
  originState: "MO",
  destCity: "Tulsa",
  destState: "OK",
  pickupOn: "2026-10-17",
  deliveredOn: "2026-10-19",
  deliveredAt: "2026-10-19T18:00:00.000Z",
  loadedMiles: 180,
  emptyMiles: 20,
  linehaulCents: cents(150_000, "linehaul"),
  fuelSurchargeCents: cents(15_000, "fuel surcharge"),
  stateMiles: [],
  accessorials: [],
  ...over,
});

const noRefs = /quickbooks|qbo|intuit/i;

describe("review labels", () => {
  it("names every status and every reason, with no vendor name", () => {
    for (const s of INVOICE_REVIEW_STATUSES) {
      expect(REVIEW_STATUS_LABELS[s], s).toMatch(/\S/);
      expect(REVIEW_STATUS_LABELS[s]).not.toMatch(noRefs);
    }
    for (const r of INVOICE_REVIEW_REASONS) {
      expect(REVIEW_REASON_LABELS[r], r).toMatch(/\S/);
      expect(REVIEW_REASON_LABELS[r]).not.toMatch(noRefs);
      const sentence = reviewReasonSentence(r, detail());
      expect(sentence, r).toMatch(/\.$/);
      expect(sentence).not.toMatch(noRefs);
      expect(sentence).not.toMatch(/\u2014/);
    }
    expect(Object.keys(REVIEW_STATUS_LABELS).sort()).toEqual([...INVOICE_REVIEW_STATUSES].sort());
    expect(Object.keys(REVIEW_REASON_LABELS).sort()).toEqual([...INVOICE_REVIEW_REASONS].sort());
  });

  it("puts the review's own amounts in the sentences", () => {
    expect(reviewReasonSentence("engine_total_differs", detail())).toBe(
      "The engine's total for this load is $1,650.00, the invoice says $1,500.00.",
    );
    expect(reviewReasonSentence("rate_confirmation_differs", detail())).toBe(
      "The rate confirmation says $1,450.00; the load says $1,400.00.",
    );
    expect(reviewReasonSentence("posted_amount_differs", detail())).toBe(
      "The accounting system holds this invoice at $1,510.00.",
    );
    expect(reviewReasonSentence("same_amount_recent", detail())).toBe(
      "Another invoice for this customer, same amount, within two weeks: X-INV-1, X-INV-2.",
    );
    expect(reviewReasonSentence("posted_amount_differs", detail({ qboAmountCents: null }))).toBe(
      "The accounting system holds this invoice at an unknown amount.",
    );
  });

  it("says why a post failed in plain words, and never echoes an unknown category", () => {
    expect(reviewReasonSentence("posting_failed", detail({ failureCategory: "timeout" }))).toBe(
      "The post to accounting failed: no reply in time.",
    );
    for (const raw of [null, "made_up", "constructor", "toString", "<script>"]) {
      expect(reviewReasonSentence("posting_failed", detail({ failureCategory: raw }))).toBe(
        "The post to accounting failed: it was refused.",
      );
    }
  });

  it("gives the accounting line for each place an invoice can stand", () => {
    const base = { posted: false, madeByQueue: true, emailStatus: null, sentOn: null, sentBy: null };
    expect(accountingLine(base)).toBe("Not posted to accounting yet");
    // An invoice from earlier records is never posted from here, so it never reads as waiting on one.
    expect(accountingLine({ ...base, madeByQueue: false })).toBe("From earlier records, not posted from here");
    expect(accountingLine({ ...base, madeByQueue: false, sentOn: "2026-10-21" })).toBe("Sent 2026-10-21");
    expect(accountingLine({ ...base, posted: true })).toBe("Posted, unsent");
    expect(accountingLine({ ...base, posted: true, emailStatus: "not_set" })).toBe("Posted, unsent");
    expect(accountingLine({ ...base, posted: true, emailStatus: "need_to_send" })).toBe(
      "Posted, unsent (in the accounting system's send queue)",
    );
    expect(accountingLine({ ...base, posted: true, emailStatus: "email_sent" })).toBe(
      "Posted; the accounting system shows it emailed",
    );
    expect(accountingLine({ ...base, posted: true, sentOn: "2026-10-21" })).toBe("Sent 2026-10-21");
    expect(accountingLine({ ...base, posted: true, sentOn: "2026-10-21", sentBy: "staff" })).toBe(
      "Sent 2026-10-21 by staff",
    );
  });

  it("has an outcome for the new refusals, with no vendor name", () => {
    expect(OUTCOME_LABELS.no_billing_address).toBe(
      "This customer has no billing address on file, so it was not posted.",
    );
    for (const k of ["not_posted", "not_ready", "validation", "not_found"]) {
      expect(reviewWriteLabel(k), k).toMatch(/\.$/);
      expect(reviewWriteLabel(k)).not.toMatch(noRefs);
    }
    // Mark as sent's "not posted" is its own sentence, never the proposal outcome of that name.
    expect(reviewWriteLabel("not_posted")).not.toBe(OUTCOME_LABELS.not_posted);
    expect(reviewWriteLabel("unknown")).toBe(OUTCOME_LABELS.unknown);
    expect(reviewWriteLabel("toString")).toBe(OUTCOME_FALLBACK);
    expect(reviewWriteLabel(null)).toBe(OUTCOME_FALLBACK);
  });
});

describe("latest postings", () => {
  const row = (subjectId: string, attempt: number, state: string, failureCategory: string | null = null) => ({
    kind: "invoice",
    subjectId,
    attempt,
    state,
    failureCategory,
  });

  it("keeps the highest attempt per invoice, in any order", () => {
    const out = latestPostings([
      row(INVOICE, 2, "confirmed"),
      row(INVOICE, 1, "failed", "validation"),
      row(id(9), 1, "unknown"),
    ]);
    expect(out.get(INVOICE)).toEqual({ state: "confirmed", failureCategory: null });
    expect(out.get(id(9))).toEqual({ state: "unknown", failureCategory: null });
  });

  it("skips other kinds and reads a state it does not know as unknown", () => {
    const out = latestPostings([
      { ...row(id(7), 3, "confirmed"), kind: "payout" },
      row(INVOICE, 1, "half_done"),
    ]);
    expect(out.has(id(7))).toBe(false);
    expect(out.get(INVOICE)).toEqual({ state: "unknown", failureCategory: null });
  });
});

describe("review input from rows", () => {
  const facts = (
    over: { invoices?: InvoiceRow[]; loads?: LoadRecord[]; pod?: boolean; cards?: string[] } = {},
  ) =>
    reviewFactsOf({
      invoices: over.invoices ?? [invoice()],
      customers: [{ id: CUSTOMER, pod_required: over.pod ?? false }],
      loads: over.loads ?? [load()],
      documents: [],
      postings: new Map(),
      queueCardLoads: new Set(over.cards ?? []),
    });

  it("takes the engine's total and linehaul from the load", () => {
    const input = reviewInputOf(invoice(), facts());
    expect(input.engineTotalCents).toBe(165_000);
    expect(input.engineLinehaulCents).toBe(150_000);
    expect(input.siblings).toEqual([]);
    expect(input.posting).toBeNull();
    expect(reviewInvoice(input).status).toBe("needs_review");
  });

  it("lists the customer's other invoices as siblings, never the invoice itself", () => {
    const other = invoice({ id: id(4), invoice_number: "X-INV-4", issued_on: "2026-10-18" });
    const input = reviewInputOf(invoice(), facts({ invoices: [invoice(), other] }));
    expect(input.siblings.map((s) => s.id)).toEqual([id(4)]);
    const review = reviewInvoice(input);
    expect(review.status).toBe("duplicate_warning");
    expect(review.duplicateOf).toEqual([id(4)]);
  });

  it("has no engine total for a load without a rate, and none for a missing load", () => {
    expect(reviewInputOf(invoice(), facts({ loads: [load({ linehaulCents: null })] })).engineTotalCents).toBeNull();
    const none = reviewInputOf(invoice(), facts({ loads: [] }));
    expect(none.engineTotalCents).toBeNull();
    expect(none.engineLinehaulCents).toBeNull();
  });

  it("reads an invoice as made by the queue only with its load's card, from the start date on", () => {
    const made = (inv: InvoiceRow, cards: string[]) => reviewInputOf(inv, facts({ cards })).invoice.madeByQueue;
    const start = invoice({ issued_on: flags.invoicesStart });
    expect(made(start, [LOAD])).toBe(true);
    // No card for its load, another load's card, an opening balance, or issued before the start.
    expect(made(start, [])).toBe(false);
    expect(made(start, [id(9)])).toBe(false);
    expect(made(invoice({ source: "opening", load_id: null, issued_on: flags.invoicesStart }), [LOAD])).toBe(false);
    expect(made(invoice({ issued_on: addDays(flags.invoicesStart, -1) }), [LOAD])).toBe(false);
  });

  it("notes an unposted ready invoice as not posted only when the queue made it", () => {
    const reviewed = invoice({ issued_on: flags.invoicesStart, reviewed_at: "2026-10-21T15:00:00.000Z" });
    const queue = reviewInvoice(reviewInputOf(reviewed, facts({ invoices: [reviewed], cards: [LOAD] })));
    expect(queue).toMatchObject({ status: "ready_to_send", reasons: ["not_posted"] });
    const history = reviewInvoice(reviewInputOf(reviewed, facts({ invoices: [reviewed] })));
    expect(history).toMatchObject({ status: "ready_to_send", reasons: [] });
  });

  it("carries the customer's document rule", () => {
    const input = reviewInputOf(invoice(), facts({ pod: true }));
    expect(input.customer.podRequired).toBe(true);
    expect(reviewInvoice(input).status).toBe("missing_documents");
  });

  it("refuses an invoice whose customer was not read, and a stored amount that is not whole cents", () => {
    const f = facts();
    expect(() => reviewInputOf(invoice({ customer_id: id(5) }), f)).toThrow("has no customer row");
    expect(() => reviewInputOf(invoice({ amount_cents: 10.5 }), f)).toThrow(InputError);
    expect(() => reviewInputOf(invoice({ qbo_amount_cents: Number.NaN }), f)).toThrow(InputError);
  });

  it("reads Postgres bigint text as cents", () => {
    const input = reviewInputOf(
      invoice({ amount_cents: "165000" as unknown as number, qbo_amount_cents: "165000" as unknown as number }),
      facts(),
    );
    expect(input.invoice.amountCents).toBe(165_000);
    expect(input.invoice.qboAmountCents).toBe(165_000);
  });
});
