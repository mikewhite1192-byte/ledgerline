// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEW_WRITE_LABELS } from "@/lib/invoices/labels";
import type { InvoiceReviewView } from "@/lib/invoices/review-read";
import type { InvoiceReviewReason, InvoiceReviewStatus } from "@/lib/rules-engine";
import { MarkReviewedForm, MarkSentForm } from "./review-actions";
import { ReviewCard } from "./review-card";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

const INVOICE = "33333333-3333-4333-8333-333333333333";
const LOAD = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const MEMBER = "66666666-6666-4666-8666-666666666666";
const TODAY = "2026-10-27";

function view(
  status: InvoiceReviewStatus,
  reasons: InvoiceReviewReason[],
  over: Partial<InvoiceReviewView> = {},
): InvoiceReviewView {
  return {
    invoiceId: INVOICE,
    invoiceNumber: "X-INV-1",
    invoiceStatus: "open",
    customerId: OTHER,
    loadId: LOAD,
    amountCents: 150_000,
    issuedOn: "2026-10-20",
    review: { status, reasons, sources: [], sentOn: null, duplicateOf: [] },
    statusLabel: status,
    reasons: reasons.map((reason) => ({ reason, label: reason, sentence: `Sentence for ${reason}.` })),
    inQueue: true,
    posted: false,
    madeByQueue: true,
    emailStatus: null,
    qboAmountCents: null,
    reviewedAt: null,
    reviewedByMembershipId: null,
    reviewNote: null,
    sentOn: null,
    sentByMembershipId: null,
    duplicates: [],
    posting: null,
    podRequired: false,
    ...over,
  };
}

const card = (v: InvoiceReviewView, roles: Map<string, string> = new Map()) =>
  render(<ReviewCard view={v} roles={roles} today={TODAY} timezone="America/Chicago" />);

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// The JSON body of the first request a stubbed fetch saw.
const sentBody = (fetch: ReturnType<typeof answer>) =>
  JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));

describe("the Review card", () => {
  it("offers Mark reviewed on an unreviewed invoice, and nothing that sends", () => {
    card(view("needs_review", ["not_reviewed"]));
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark as sent" })).toBeNull();
    expect(screen.getByText("Sentence for not_reviewed.")).toBeTruthy();
    expect(screen.getByText("Not posted to accounting yet")).toBeTruthy();
    expect(screen.queryByText(/send invoice|email/i)).toBeNull();
  });

  it("offers Mark reviewed on a duplicate warning, since only a review clears it, with the other invoice linked", () => {
    card(view("duplicate_warning", ["same_amount_recent", "not_reviewed"], { duplicates: [{ id: OTHER, invoiceNumber: "X-INV-0" }] }));
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "X-INV-0" }).getAttribute("href")).toBe(`/records/invoices/${OTHER}`);
  });

  it("offers Mark as sent only when ready and posted, with the date bounded by the invoice date and today", () => {
    const ready = { reviewedAt: "2026-10-21T15:00:00.000Z", reviewedByMembershipId: MEMBER, posted: true, emailStatus: "need_to_send" as const };
    card(view("ready_to_send", [], ready), new Map([[MEMBER, "staff"]]));
    expect(screen.getByRole("button", { name: "Mark as sent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).toBeNull();
    const date = screen.getByLabelText("Date sent") as HTMLInputElement;
    expect(date.min).toBe("2026-10-20");
    expect(date.max).toBe(TODAY);
    expect(screen.getByText("Posted, unsent (in the accounting system's send queue)")).toBeTruthy();
    expect(screen.getByText(/by staff/)).toBeTruthy();
    cleanup();
    // The invoice queue made it and it is not posted yet: it is posted before the send is recorded.
    card(view("ready_to_send", ["not_posted"], { reviewedAt: "2026-10-21T15:00:00.000Z" }));
    expect(screen.queryByRole("button", { name: "Mark as sent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Record as sent" })).toBeNull();
  });

  it("offers Record as sent on a ready invoice from earlier records, and never asks for a post", async () => {
    const fetch = answer(200, { ok: true, changed: true });
    card(view("ready_to_send", [], { reviewedAt: "2026-10-21T15:00:00.000Z", madeByQueue: false }));
    expect(screen.getByText("From earlier records, not posted from here")).toBeTruthy();
    expect(screen.getByText("Send it to the customer yourself first. This only records the date here.")).toBeTruthy();
    // Nothing asks for a post: no post button, no "post it first", no "not posted yet".
    expect(screen.queryByText(/\bpost\b|not posted to accounting yet/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark as sent" })).toBeNull();
    const date = screen.getByLabelText("Date sent") as HTMLInputElement;
    expect(date.min).toBe("2026-10-20");
    expect(date.max).toBe(TODAY);
    fireEvent.click(screen.getByRole("button", { name: "Record as sent" }));
    expect(await screen.findByText("Recorded as sent.")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(`/api/invoices/${INVOICE}/mark-sent`, expect.objectContaining({ method: "POST" }));
    expect(sentBody(fetch)).toEqual({ sentOn: TODAY });
    cleanup();
    // Not reviewed yet: Mark reviewed first, and still no post.
    card(view("needs_review", ["not_reviewed"], { madeByQueue: false }));
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record as sent" })).toBeNull();
    expect(screen.queryByText(/\bpost\b|not posted to accounting yet/i)).toBeNull();
  });

  it("reads a recorded send with who recorded it, and offers nothing more", () => {
    card(
      view("ready_to_send", [], {
        reviewedAt: "2026-10-21T15:00:00.000Z",
        posted: true,
        sentOn: "2026-10-22",
        sentByMembershipId: MEMBER,
        inQueue: false,
      }),
      new Map([[MEMBER, "admin"]]),
    );
    expect(screen.getByText("Sent Oct 22, 2026 by admin")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("offers Retry post on a failed post and Check pending on an unconfirmed one", () => {
    card(view("sync_error", ["posting_failed", "not_reviewed"]));
    expect(screen.getByRole("button", { name: "Retry post" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check pending" })).toBeNull();
    expect(screen.getByRole("link", { name: "See the attempts" }).getAttribute("href")).toBe("#posting-attempts");
    cleanup();
    card(view("sync_error", ["posting_unknown", "not_reviewed"]));
    expect(screen.getByRole("button", { name: "Check pending" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry post" })).toBeNull();
  });

  it("opens the load on a rate mismatch", () => {
    card(view("rate_mismatch", ["engine_total_differs"], { reviewedAt: "2026-10-21T15:00:00.000Z" }));
    expect(screen.getByRole("link", { name: "Open the load" }).getAttribute("href")).toBe(`/records/loads/${LOAD}`);
    expect(screen.getByRole("link", { name: "See the load" })).toBeTruthy();
  });

  it("offers nothing on a paid or void invoice", () => {
    card(view("ready_to_send", [], { invoiceStatus: "paid", inQueue: false }));
    expect(screen.getByText("Paid and void invoices are settled; they are not reviewed.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("Mark as sent", () => {
  const url = `/api/invoices/${INVOICE}/mark-sent`;

  it("refuses a date before the invoice or after today without calling the server", () => {
    const fetch = answer(200, { ok: true, changed: true });
    render(<MarkSentForm url={url} issuedOn="2026-10-20" today={TODAY} />);
    const date = screen.getByLabelText("Date sent");
    fireEvent.change(date, { target: { value: "2026-10-28" } });
    expect(screen.getByText("Not after today.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Mark as sent" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(date, { target: { value: "2026-10-19" } });
    expect(screen.getByText("Not before the invoice date.")).toBeTruthy();
    fireEvent.submit(date.closest("form")!);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records the date once and says so on a repeat", async () => {
    let fetch = answer(200, { ok: true, changed: true });
    render(<MarkSentForm url={url} issuedOn="2026-10-20" today={TODAY} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark as sent" }));
    expect((await screen.findByText("Recorded as sent.")).getAttribute("role")).toBe("status");
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: "POST" }));
    expect(sentBody(fetch)).toEqual({ sentOn: TODAY });
    expect(refresh).toHaveBeenCalledTimes(1);
    fetch = answer(200, { ok: true, changed: false });
    fireEvent.click(screen.getByRole("button", { name: "Mark as sent" }));
    expect(await screen.findByText("This was already recorded as sent.")).toBeTruthy();
  });

  it("says why it was refused, by category, and an unreadable reply is unknown", async () => {
    answer(409, { error: "not_posted" });
    render(<MarkSentForm url={url} issuedOn="2026-10-20" today={TODAY} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark as sent" }));
    expect(await screen.findByText(REVIEW_WRITE_LABELS.not_posted)).toBeTruthy();
    answer(200, { ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Mark as sent" }));
    expect(await screen.findByText(/The outcome is not known yet/)).toBeTruthy();
  });
});

describe("Mark reviewed", () => {
  const url = `/api/invoices/${INVOICE}/review`;

  it("sends no note when none is given, and the trimmed note when one is", async () => {
    let fetch = answer(200, { ok: true, changed: true });
    render(<MarkReviewedForm url={url} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByText("Marked reviewed.")).toBeTruthy();
    expect(sentBody(fetch)).toEqual({});
    fetch = answer(200, { ok: true, changed: false });
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "  Checked the rate.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByText("Someone already marked this reviewed.")).toBeTruthy();
    expect(sentBody(fetch)).toEqual({ note: "Checked the rate." });
  });

  it("will not send a note over 240 characters", () => {
    const fetch = answer(200, { ok: true, changed: true });
    render(<MarkReviewedForm url={url} />);
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "x".repeat(241) } });
    expect(screen.getByText("At most 240 characters.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Mark reviewed" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText("Note (optional)").closest("form")!);
    expect(fetch).not.toHaveBeenCalled();
  });
});
