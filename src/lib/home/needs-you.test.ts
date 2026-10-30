import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceListRow } from "@/lib/advances/read";
import type { ProposalView, TurnView } from "@/lib/agent/view";
import type { Queryable } from "@/lib/db";
import type { InvoiceListRow } from "@/lib/invoices/views";
import type { SettlementListRow } from "@/lib/settlements/views";
import { carrierToday } from "@/lib/tenant/shell";
import * as fx from "@/test/page-fixtures";
import { advancesRow, cardsRow, escalatedRow, invoiceCardsRow, pastDueRow, paystubsRow, readNeedsYou } from "./needs-you";

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
  it("counts requests that went to a person, links to the chat's page with no fragment, and carries no amount", () => {
    expect(escalatedRow(2)).toEqual({
      key: "escalated",
      count: 2,
      atLeast: false,
      what: "requests in your chat escalated to a person",
      amounts: [],
      href: "/",
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
    expect(rows.map((r) => [r.key, r.count, r.href])).toEqual([["escalated", 2, "/"]]);
    expect(asked).toHaveLength(1);
    expect(asked[0].params).toEqual(["sub-1", null, "2026-10-29T12:00:00.000Z"]);
    expect(asked[0].sql).toContain("t.ended_reason = 'escalated'");
    expect(asked[0].sql).toContain("c.created_by = $1");
    expect(asked[0].sql).toContain("c.demo_session_id IS NOT DISTINCT FROM CAST($2 AS uuid)");
    expect(asked[0].sql).toContain("make_interval(days => 7)");
  });
});
