import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceListRow } from "@/lib/advances/read";
import type { ProposalView, TurnView } from "@/lib/agent/view";
import type { Queryable } from "@/lib/db";
import type { InvoiceListRow } from "@/lib/invoices/views";
import { MONEY_ACTION_KINDS } from "@/lib/money/types";
import type { SettlementListRow } from "@/lib/settlements/views";
import { carrierToday } from "@/lib/tenant/shell";
import * as fx from "@/test/page-fixtures";
import {
  advancesRow,
  BOOKS_LINKED_KINDS,
  booksHref,
  booksRow,
  cardsRow,
  escalatedRow,
  invoiceCardsRow,
  pastDueRow,
  payCheckRow,
  paystubsRow,
  readNeedsYou,
  type BooksStuckRow,
} from "./needs-you";

// The reads the strip makes, answered from fixture rows, with what each was asked for.
const reads = vi.hoisted(() => ({
  settlements: [] as unknown[],
  advances: [] as unknown[],
  cards: [] as unknown[],
  invoices: [] as unknown[],
  asked: [] as string[],
}));
vi.mock("@/lib/settlements/views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settlements/views")>()),
  readSettlementsView: async (_q: Queryable, asked: string | null) => {
    reads.asked.push(`settlements:${asked}`);
    return { rows: reads.settlements };
  },
}));
vi.mock("@/lib/advances/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/advances/read")>()),
  readAdvanceList: async (_q: Queryable, status: string | null) => {
    reads.asked.push(`advances:${status}`);
    return reads.advances;
  },
}));
vi.mock("@/lib/agent/gateway/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/gateway/store")>()),
  readEngineProposalViews: async (_q: Queryable, kind: string, limit: number) => {
    reads.asked.push(`cards:${kind}:${limit}`);
    return reads.cards;
  },
}));
vi.mock("@/lib/invoices/views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invoices/views")>()),
  readInvoiceList: async (_q: Queryable, asOf: string) => {
    reads.asked.push(`invoices:${asOf}`);
    return reads.invoices;
  },
}));

beforeEach(() => {
  reads.settlements = [];
  reads.advances = [];
  reads.cards = [];
  reads.invoices = [];
  reads.asked = [];
});

const card = (over: Partial<ProposalView>): ProposalView => ({ ...fx.PROPOSALS[0], ...over });
const turnWith = (id: string, proposals: ProposalView[]): TurnView => ({ ...fx.TURNS[0], id, proposals });
const advance = (over: Partial<AdvanceListRow>): AdvanceListRow => ({ ...fx.ADVANCES[0], ...over });
const invoice = (over: Partial<InvoiceListRow>): InvoiceListRow => ({ ...fx.INVOICES[0], ...over });
const paystub = (over: Partial<SettlementListRow>): SettlementListRow => ({ ...fx.SETTLEMENTS_VIEW.rows[0], ...over });

describe("the rows", () => {
  it("counts the cards in the chat that wait for approval, once each, with money out and in, and links the newest", () => {
    const row = cardsRow([
      turnWith("t1", [card({ id: "a", amountCents: 25_000 }), card({ id: "b", status: "approved", amountCents: 99_900 })]),
      turnWith("t2", [
        card({ id: "c", kind: "detention_charge", direction: "in", amountCents: 7_500 }),
        card({ id: "d", kind: "invoice_fix", direction: "none", amountCents: 1_234 }),
        card({ id: "a", amountCents: 25_000 }),
      ]),
    ]);
    expect(row).toMatchObject({
      key: "cards",
      count: 3,
      what: "cards in your chat waiting for approval",
      amounts: [
        { cents: 25_000, label: "to pay out" },
        { cents: 7_500, label: "coming in" },
      ],
      href: "#card-a",
      linkLabel: "Go to the newest card",
    });
    expect(cardsRow([turnWith("t1", [card({ status: "done" })])])).toBeNull();
    expect(cardsRow([])).toBeNull();
  });

  it("totals this week's paystubs that wait for approval", () => {
    const row = paystubsRow([
      paystub({ id: "s1", netCents: 120_000 }),
      paystub({ id: "s2", netCents: 98_765 }),
      paystub({ id: "s3", netCents: 50_000, proposalStatus: "approved" }),
      paystub({ id: "s4", netCents: 40_000, proposalStatus: null }),
    ]);
    expect(row).toMatchObject({
      count: 2,
      what: "paystubs waiting for approval",
      amounts: [{ cents: 218_765, label: "to pay drivers" }],
      href: "/settlements",
    });
    expect(paystubsRow([paystub({ proposalStatus: "approved" })])).toBeNull();
  });

  it("totals the advance requests no one has decided, and says when the list was cut off", () => {
    const row = advancesRow([advance({ id: "a1", status: "requested", amountCents: 10_000 }), advance({ id: "a2", status: "paid" })]);
    expect(row).toMatchObject({
      count: 1,
      atLeast: false,
      what: "advance request waiting for a decision",
      amounts: [{ cents: 10_000, label: "requested" }],
      href: "/advances?status=requested",
    });
    const full = Array.from({ length: 200 }, (_, i) => advance({ id: `r${i}`, status: "requested", amountCents: 100 }));
    expect(advancesRow(full)).toMatchObject({ count: 200, atLeast: true });
  });

  it("totals the invoices waiting for approval", () => {
    const row = invoiceCardsRow([
      card({ id: "i1", kind: "invoice_post", direction: "in", amountCents: 182_500 }),
      card({ id: "i2", kind: "invoice_post", direction: "in", amountCents: 50_000, status: "executing" }),
    ]);
    expect(row).toMatchObject({
      count: 1,
      what: "invoice waiting for approval",
      amounts: [{ cents: 182_500, label: "to bill" }],
      href: "/invoices?tab=to-invoice",
    });
  });

  it("totals what is still owed on invoices past their due date, never a current or settled one", () => {
    const row = pastDueRow([
      invoice({ id: "v1", bucket: "1_30", balanceCents: 30_000 }),
      invoice({ id: "v2", bucket: "over_90", balanceCents: 12_345 }),
      invoice({ id: "v3", bucket: "current", balanceCents: 99_999 }),
      invoice({ id: "v4", bucket: null, balanceCents: 0 }),
    ]);
    expect(row).toMatchObject({
      count: 2,
      what: "invoices past due",
      amounts: [{ cents: 42_345, label: "still owed" }],
      href: "/invoices?tab=invoices",
    });
    expect(pastDueRow([invoice({ bucket: "current" })])).toBeNull();
  });
});

describe("readNeedsYou", () => {
  const q = {} as Queryable;

  it("reads each page's rows only while that page is switched on", async () => {
    const rows = await readNeedsYou(q, {
      today: "2026-10-29",
      settlements: false,
      advances: false,
      invoices: false,
    });
    expect(rows).toEqual([]);
    expect(reads.asked).toEqual([]);
  });

  it("asks for the open week, requested advances, invoice cards, and invoices as of the carrier's today", async () => {
    reads.settlements = [paystub({ netCents: 10_000 })];
    reads.advances = [advance({ status: "requested", amountCents: 5_000 })];
    reads.cards = [card({ kind: "invoice_post", direction: "in", amountCents: 182_500 })];
    reads.invoices = [invoice({ bucket: "31_60", balanceCents: 1_000 })];
    // Home passes the carrier's today: 10 PM on Oct 29 in Chicago is already Oct 30 in UTC.
    const today = carrierToday("America/Chicago", new Date("2026-10-30T03:00:00Z"));
    expect(today).toBe("2026-10-29");
    const rows = await readNeedsYou(q, {
      today,
      settlements: true,
      advances: true,
      invoices: true,
    });
    expect(reads.asked).toEqual(["settlements:null", "advances:requested", "cards:invoice_post:200", "invoices:2026-10-29"]);
    expect(rows.map((r) => r.key)).toEqual(["paystubs", "advances", "invoice_cards", "past_due"]);
  });
});

describe("the escalated row", () => {
  it("counts requests that went to a person, opens the agent card with #ask, and carries no amount", () => {
    expect(escalatedRow(2)).toEqual({
      key: "escalated",
      count: 2,
      atLeast: false,
      what: "requests in your chat escalated to a person",
      amounts: [],
      href: "#ask",
      linkLabel: "Open your chat",
    });
    expect(escalatedRow(1)?.what).toBe("request in your chat escalated to a person");
  });

  it("is left out with none or an unreadable count", () => {
    expect(escalatedRow(0)).toBeNull();
    expect(escalatedRow(Number.NaN)).toBeNull();
  });

  it("is read only when Home asks, in this person's own chat and visit, over the last 7 days", async () => {
    const asked: { sql: string; params: unknown[] }[] = [];
    const q = {
      query: async (sql: string, params: unknown[]) => {
        asked.push({ sql, params });
        return [{ n: "2" }];
      },
    } as unknown as Queryable;
    const base = { today: "2026-10-29" as const, settlements: false, advances: false, invoices: false };
    expect(await readNeedsYou(q, base)).toEqual([]);
    expect(asked).toEqual([]);
    const now = new Date("2026-10-29T12:00:00Z");
    const rows = await readNeedsYou(q, { ...base, escalations: { now, sub: "sub-1", visitId: null } });
    expect(rows.map((r) => [r.key, r.count, r.href])).toEqual([["escalated", 2, "#ask"]]);
    expect(asked).toHaveLength(1);
    expect(asked[0].params).toEqual(["sub-1", null, "2026-10-29T12:00:00.000Z"]);
    expect(asked[0].sql).toContain("t.ended_reason = 'escalated'");
    expect(asked[0].sql).toContain("c.created_by = $1");
    expect(asked[0].sql).toContain("c.demo_session_id IS NOT DISTINCT FROM CAST($2 AS uuid)");
    expect(asked[0].sql).toContain("make_interval(days => 7)");
  });
});

describe("Home's books row (D-104)", () => {
  const SUB = "00000000-0000-4000-8000-000000000001";
  const DRIVER = "00000000-0000-4000-8000-000000000002";
  const stuck = (over: Partial<BooksStuckRow> = {}): BooksStuckRow => ({
    kind: "advance_expense",
    subjectId: SUB,
    state: "failed",
    attempt: 3,
    failureCategory: "validation",
    checkCount: 0,
    amountCents: 12_500,
    ...over,
  });

  it("counts a record whose tries ran out and opens the oldest record page", () => {
    const row = booksRow([stuck(), stuck({ kind: "invoice", subjectId: DRIVER, amountCents: 100 })], 3);
    expect(row).toEqual({
      key: "books",
      count: 2,
      atLeast: false,
      what: "records QuickBooks did not take",
      amounts: [{ cents: 12_600, label: "not in QuickBooks" }],
      href: `/records/advances/${SUB}`,
      linkLabel: "Open the oldest one",
    });
    expect(booksRow([stuck()], 3)?.what).toBe("record QuickBooks did not take");
  });

  it("leaves out a failure with tries left, but never another amount or an unread post", () => {
    expect(booksRow([stuck({ attempt: 2 })], 3)).toBeNull();
    expect(booksRow([stuck({ attempt: 1, failureCategory: "amount_mismatch" })], 3)?.count).toBe(1);
    expect(booksRow([stuck({ state: "unknown", attempt: 1, checkCount: 49 })], 3)).toBeNull();
    expect(booksRow([stuck({ state: "unknown", attempt: 1, checkCount: 50 })], 3)?.count).toBe(1);
  });

  it("links each kind to the page that shows it", () => {
    const at = (kind: BooksStuckRow["kind"]) => booksHref({ kind, subjectId: SUB });
    expect(at("settlement_bill")).toBe(`/records/settlements/${SUB}`);
    expect(at("settlement_bill_payment")).toBe(`/records/settlements/${SUB}`);
    expect(at("invoice")).toBe(`/records/invoices/${SUB}`);
    expect(at("customer_payment")).toBe(`/records/customer_payments/${SUB}`);
    expect(at("money_code_expense")).toBe(`/money-codes/${SUB}`);
    // No page shows an escrow release's post, so Home links none.
    expect(at("escrow_release_expense")).toBeNull();
    expect(at("advance_payout")).toBeNull();
    // The read's kind list is exactly the kinds linked here.
    const linked = MONEY_ACTION_KINDS.filter((k) => at(k) !== null);
    expect([...BOOKS_LINKED_KINDS].sort()).toEqual([...linked].sort());
  });

  it("is read only when Home asks, as the latest accounting row of each record", async () => {
    const asked: { sql: string; params: unknown[] }[] = [];
    const q = {
      query: async (sql: string, params: unknown[]) => {
        asked.push({ sql, params });
        return [
          {
            kind: "settlement_bill",
            subject_id: SUB,
            state: "failed",
            attempt: "3",
            failure_category: "validation",
            check_count: "0",
            amount_cents: "50000",
          },
        ];
      },
    } as unknown as Queryable;
    const base = { today: "2026-11-03" as const, settlements: false, advances: false, invoices: false };
    expect(await readNeedsYou(q, base)).toEqual([]);
    expect(asked).toEqual([]);
    const rows = await readNeedsYou(q, { ...base, books: { maxAttempts: 3 } });
    expect(rows.map((r) => [r.key, r.count, r.href])).toEqual([["books", 1, `/records/settlements/${SUB}`]]);
    expect(asked).toHaveLength(1);
    // Only the kinds Home links are read, before the limit, so an unlinked kind never uses it up.
    expect(asked[0].params).toEqual([
      3,
      50,
      50,
      "{settlement_bill,settlement_bill_payment,advance_expense,invoice,customer_payment,money_code_expense}",
    ]);
    expect(asked[0].sql).toContain("channel = 'accounting'");
    expect(asked[0].sql).toContain("kind = ANY(CAST($4 AS text[]))");
    expect(asked[0].sql).toContain("DISTINCT ON (kind, subject_id)");
  });
});

describe("payCheckRow", () => {
  const run = (status: "running" | "done" | "failed", needs: number | undefined) => ({
    id: "0f0e0d0c-0b0a-4908-8706-050403020100",
    status,
    counts: needs === undefined ? {} : { needs_person: needs },
  });

  it("lists the last finished pay check's items that need the owner, linked to the check", () => {
    expect(payCheckRow(run("done", 3) as never)).toEqual({
      key: "pay_check",
      count: 3,
      atLeast: false,
      what: "pay check items need you",
      amounts: [],
      href: "/sweep/0f0e0d0c-0b0a-4908-8706-050403020100",
      linkLabel: "Open the pay check",
    });
    expect(payCheckRow(run("done", 1) as never)?.what).toBe("pay check item needs you");
  });

  it("adds nothing for no check, a running one, or one with nothing for the owner", () => {
    expect(payCheckRow(null)).toBeNull();
    expect(payCheckRow(run("running", 3) as never)).toBeNull();
    expect(payCheckRow(run("done", 0) as never)).toBeNull();
    expect(payCheckRow(run("done", undefined) as never)).toBeNull();
  });
});
