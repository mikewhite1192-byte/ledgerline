import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { MoneyActionState } from "../money/types";
import { addDays } from "../time/local-date";
import { invoiceRecordActions, type InvoiceRecordPage } from "./record-page";
import type { InvoiceReviewView } from "./review-read";
import type { InvoiceRecordView } from "./views";

// The buttons an invoice's record page offers, on rows built here. No database.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const saved = { invoicesEnabled: flags.invoicesEnabled };

beforeEach(() => {
  flags.invoicesEnabled = true;
});

afterEach(() => {
  Object.assign(flags, saved);
});

const record = (over: Partial<InvoiceRecordView> = {}): InvoiceRecordView => ({
  id: id(3),
  invoiceNumber: "X-INV-3",
  customerId: id(1),
  customerName: "Test customer",
  loadId: id(2),
  status: "open",
  amountCents: 165_000,
  balanceCents: 165_000,
  issuedOn: flags.invoicesStart,
  dueOn: addDays(flags.invoicesStart, 30),
  bucket: null,
  posted: false,
  source: "load",
  loadNumber: "X-L1",
  qboTail: null,
  lines: null,
  applications: [],
  ledger: [],
  ...over,
});

const ledger = (state: MoneyActionState): InvoiceRecordView["ledger"] => [
  { id: id(8), attempt: 1, state, failureCategory: null, amountCents: 165_000, createdAt: "2026-10-21T15:00:00.000Z" },
];

// Only the review status matters to the buttons.
const review = (status: InvoiceReviewView["review"]["status"]): InvoiceRecordPage["review"] => ({
  view: { review: { status } } as InvoiceReviewView,
  roles: new Map(),
});

const page = (over: Partial<InvoiceRecordPage> = {}): InvoiceRecordPage => ({
  record: record(),
  review: null,
  queueMade: true,
  ...over,
});

describe("the invoice record page's buttons", () => {
  it("offers the post for an unposted invoice the queue made, never for one from earlier records", () => {
    expect(invoiceRecordActions(page())).toEqual({ post: true, check: false });
    expect(invoiceRecordActions(page({ queueMade: false }))).toEqual({ post: false, check: false });
    expect(invoiceRecordActions(page({ review: review("needs_review") })).post).toBe(true);
    expect(invoiceRecordActions(page({ review: review("needs_review"), queueMade: false })).post).toBe(false);
  });

  it("never offers the post for a queue-made invoice dated before the invoices start", () => {
    expect(invoiceRecordActions(page({ record: record({ issuedOn: addDays(flags.invoicesStart, -1) }) })).post).toBe(
      false,
    );
  });

  it("offers nothing once a post is confirmed, for a void invoice, or with the switch off", () => {
    for (const over of [
      { record: record({ posted: true }) },
      { record: record({ ledger: ledger("confirmed") }) },
      { record: record({ status: "void" }) },
    ]) {
      expect(invoiceRecordActions(page(over)).post).toBe(false);
    }
    flags.invoicesEnabled = false;
    expect(invoiceRecordActions(page({ record: record({ ledger: ledger("unknown") }) }))).toEqual({
      post: false,
      check: false,
    });
  });

  it("offers the check for a post nobody confirmed, unless the review card's own buttons are on", () => {
    expect(invoiceRecordActions(page({ record: record({ ledger: ledger("unknown") }) })).check).toBe(true);
    expect(invoiceRecordActions(page({ record: record({ ledger: ledger("sent") }) })).check).toBe(true);
    expect(
      invoiceRecordActions(page({ record: record({ ledger: ledger("unknown") }), review: review("sync_error") })),
    ).toEqual({ post: false, check: false });
  });
});
