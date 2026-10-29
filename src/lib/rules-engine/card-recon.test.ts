import { describe, expect, it } from "vitest";
import {
  BREAK_CATEGORIES,
  checkWindow,
  compareReadBack,
  fingerprintOf,
  FIX_OF,
  matchArgs,
  MAX_CANDIDATES,
  portalPrefix,
  rankCandidates,
  reconcileStatement,
  sentInWindow,
  SEVERITY_OF,
  topIsTied,
  type CandidateDriver,
  type CardFact,
  type LedgerFact,
  type MatchTxn,
  type StatementTxn,
} from "./card-recon";

// The card check's pure engine: the statement against our records, each payment record against
// its read-back, the window in a named zone, and the candidates for a card on no one's file. Every
// fact is passed in; no clock, no database, no model.

const WINDOW = { start: "2026-10-16", end: "2026-10-29" };

function txn(over: Partial<StatementTxn> = {}): StatementTxn {
  return {
    id: "t-1",
    providerRef: "ref-1",
    kind: "fuel",
    cardToken: "tok-a",
    cardLast4: "1111",
    portalName: "D-01",
    postedOn: "2026-10-20",
    amountCents: 41_250,
    state: "OK",
    gallonsMilli: 100_000,
    ...over,
  };
}

const CARD: CardFact = { driverId: "drv-a", providerToken: "tok-a", portalName: null, status: "active" };

function statement(txns: StatementTxn[], over: Partial<Parameters<typeof reconcileStatement>[0]> = {}) {
  return reconcileStatement({ txns, purchases: [], cards: [CARD], cardLoads: [], window: WINDOW, ...over });
}

describe("the statement against our records", () => {
  it("finds nothing when every purchase and card load matches to the cent", () => {
    const out = statement(
      [txn(), txn({ id: "t-2", providerRef: "load-1", kind: "load", amountCents: 20_000, gallonsMilli: null })],
      {
        purchases: [{ id: "p-1", driverId: "drv-a", purchaseRef: "ref-1", amountCents: 41_250 }],
        cardLoads: [{ moneyActionId: "m-1", outsideId: "load-1", amountCents: 20_000, driverId: "drv-a" }],
      },
    );
    expect(out).toEqual([]);
  });

  it("calls a one-cent gap on a fuel purchase a difference, with both amounts", () => {
    const [b, ...rest] = statement([txn()], {
      purchases: [{ id: "p-1", driverId: "drv-a", purchaseRef: "ref-1", amountCents: 41_249 }],
    });
    expect(rest).toEqual([]);
    expect(b).toMatchObject({
      category: "fuel_amount_differs",
      severity: "medium",
      fixKind: "by_hand",
      outsideSystem: "fuel_card_sim",
      cardTransactionId: "t-1",
      fuelPurchaseId: "p-1",
      driverId: "drv-a",
      ourCents: 41_249,
      outsideCents: 41_250,
    });
  });

  it("tells a purchase never recorded on a known card from a card on no driver's file", () => {
    const out = statement([txn(), txn({ id: "t-2", providerRef: "ref-2", cardToken: "tok-unknown" })]);
    expect(out.map((b) => [b.category, b.cardTransactionId, b.driverId])).toEqual([
      ["purchase_not_recorded", "t-1", "drv-a"],
      ["card_unknown", "t-2", null],
    ]);
    expect(out[1].severity).toBe("high");
    expect(out[1].fixKind).toBe("by_hand");
  });

  it("matches a reference whole, never by a part of it", () => {
    const out = statement([txn({ providerRef: "ref-10" })], {
      purchases: [{ id: "p-1", driverId: "drv-a", purchaseRef: "ref-1", amountCents: 41_250 }],
    });
    expect(out.map((b) => b.category)).toEqual(["purchase_not_recorded"]);
  });

  it("flags a card load we have no record of, and one whose amount differs", () => {
    const loads = [
      txn({ id: "t-1", providerRef: "load-1", kind: "load", amountCents: 15_000, gallonsMilli: null, state: null }),
      txn({ id: "t-2", providerRef: "load-2", kind: "load", amountCents: 20_000, gallonsMilli: null, state: null }),
    ];
    const out = statement(loads, {
      cardLoads: [{ moneyActionId: "m-2", outsideId: "load-2", amountCents: 20_001, driverId: "drv-a" }],
    });
    expect(out.map((b) => [b.category, b.moneyActionId, b.ourCents, b.outsideCents])).toEqual([
      ["load_not_in_ledger", null, null, 15_000],
      ["load_amount_differs", "m-2", 20_001, 20_000],
    ]);
  });

  it("compares only rows posted inside the window, oldest first", () => {
    const out = statement([
      txn({ id: "t-late", providerRef: "r-late", postedOn: "2026-10-30" }),
      txn({ id: "t-b", providerRef: "r-b", postedOn: "2026-10-29" }),
      txn({ id: "t-a", providerRef: "r-a", postedOn: "2026-10-16" }),
      txn({ id: "t-early", providerRef: "r-early", postedOn: "2026-10-15" }),
    ]);
    expect(out.map((b) => b.cardTransactionId)).toEqual(["t-a", "t-b"]);
  });

  it("refuses an amount that is not whole cents", () => {
    expect(() => statement([txn({ amountCents: 412.5 })])).toThrow(RangeError);
    expect(() => statement([txn({ amountCents: -1 })])).toThrow(RangeError);
  });
});

describe("a payment record against its read-back", () => {
  const row = (over: Partial<LedgerFact> = {}): LedgerFact => ({
    id: "m-1",
    kind: "advance_payout",
    state: "confirmed",
    amountCents: 30_000,
    outsideSystem: "stripe_test",
    sentAt: "2026-10-20T15:00:00.000Z",
    ...over,
  });
  const found = (amountCents: number, status: "succeeded" | "pending" | "failed" | "canceled" = "succeeded") => ({
    ok: true as const,
    readBack: { found: true as const, system: "stripe_test" as const, type: "payout", id: "po_1", amountCents, status },
  });

  it("is clean when the other system has the same amount, succeeded", () => {
    expect(compareReadBack(row(), found(30_000))).toEqual({ kind: "clean" });
  });

  it("names each kind of difference", () => {
    const cat = (r: ReturnType<typeof compareReadBack>) => (r.kind === "break" ? r.break.category : r.kind);
    expect(cat(compareReadBack(row(), { ok: true, readBack: { found: false } }))).toBe("missing_outside");
    expect(cat(compareReadBack(row(), found(30_000, "failed")))).toBe("reversed_outside");
    expect(cat(compareReadBack(row(), found(30_000, "canceled")))).toBe("reversed_outside");
    expect(cat(compareReadBack(row(), found(30_000, "pending")))).toBe("pending_outside");
    expect(cat(compareReadBack(row(), found(29_999)))).toBe("amount_differs_outside");
  });

  it("keeps both amounts on an amount difference", () => {
    const r = compareReadBack(row(), found(30_001));
    expect(r.kind === "break" && [r.break.ourCents, r.break.outsideCents, r.break.moneyActionId]).toEqual([
      30_000,
      30_001,
      "m-1",
    ]);
  });

  it("never takes a failed or missing read as an answer", () => {
    expect(compareReadBack(row(), { ok: false, category: "timeout" })).toEqual({ kind: "unchecked", category: "timeout" });
    expect(compareReadBack(row(), null)).toEqual({ kind: "unchecked", category: "not_read" });
  });

  it("calls a record not confirmed yet a difference without reading it, and skips the rest", () => {
    const r = compareReadBack(row({ state: "unknown", outsideSystem: null }), null);
    expect(r.kind === "break" && [r.break.category, r.break.fixKind]).toEqual(["not_confirmed", "check_pending"]);
    expect(compareReadBack(row({ state: "failed" }), null)).toEqual({ kind: "clean" });
    expect(compareReadBack(row({ state: "reserved" }), null)).toEqual({ kind: "clean" });
  });
});

describe("the window, in the carrier's zone", () => {
  it("runs from windowDays back to today and refuses a window out of range", () => {
    expect(checkWindow("2026-11-02", 14)).toEqual({ start: "2026-10-19", end: "2026-11-02" });
    expect(() => checkWindow("2026-11-02", 0)).toThrow(RangeError);
    expect(() => checkWindow("2026-11-02", 61)).toThrow(RangeError);
    expect(() => checkWindow("2026-11-02", 1.5)).toThrow(RangeError);
  });

  it("puts a send on its local date across the fall clock change", () => {
    // Denver leaves daylight time on 2026-11-01: UTC-6 before, UTC-7 after.
    const w = { start: "2026-10-18", end: "2026-11-01" };
    const zone = "America/Denver";
    expect(sentInWindow("2026-10-18T05:59:00.000Z", zone, w)).toBe(false);
    expect(sentInWindow("2026-10-18T06:00:00.000Z", zone, w)).toBe(true);
    expect(sentInWindow("2026-11-02T06:59:00.000Z", zone, w)).toBe(true);
    expect(sentInWindow("2026-11-02T07:00:00.000Z", zone, w)).toBe(false);
    expect(sentInWindow(null, zone, w)).toBe(false);
  });
});

describe("the same difference across checks", () => {
  it("keeps one fingerprint whatever the amounts or the letter case", () => {
    const b = { category: "card_unknown" as const, cardTransactionId: "AB-1", moneyActionId: null, fuelPurchaseId: null };
    expect(fingerprintOf(b)).toBe(fingerprintOf({ ...b, cardTransactionId: "ab-1" }));
    expect(fingerprintOf(b)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf(b)).not.toBe(fingerprintOf({ ...b, category: "purchase_not_recorded" }));
  });

  it("gives every category a severity and a fix", () => {
    for (const c of BREAK_CATEGORIES) {
      expect(["high", "medium", "low"]).toContain(SEVERITY_OF[c]);
      expect(["card_match", "check_pending", "retry", "by_hand", "none"]).toContain(FIX_OF[c]);
    }
  });
});

describe("candidates for a card on no one's file", () => {
  const drivers: CandidateDriver[] = [
    { id: "d1", code: "BR-D01", activeFrom: "2026-01-01", activeTo: null },
    { id: "d2", code: "BR-D02", activeFrom: "2026-01-01", activeTo: null },
    { id: "d3", code: "BR-D03", activeFrom: "2026-01-01", activeTo: null },
    { id: "d4", code: "BR-D04", activeFrom: "2026-01-01", activeTo: "2026-10-19" },
    { id: "d5", code: "BR-D05", activeFrom: "2026-01-01", activeTo: null },
  ];
  const posted = { postedOn: "2026-10-20", state: "OK", portalName: "POOL CARD 7" };
  const facts = {
    drivers,
    days: [
      { driverId: "d1", day: "2026-10-20", loadId: "L1" },
      { driverId: "d2", day: "2026-10-21", loadId: "L2" },
      { driverId: "d3", day: "2026-10-19", loadId: null },
      { driverId: "d4", day: "2026-10-19", loadId: "L1" },
      { driverId: "d5", day: "2026-10-17", loadId: "L1" },
    ],
    loads: [
      { id: "L1", originState: "TX", destState: "KS" },
      { id: "L2", originState: "MO", destState: "AR" },
    ],
    stateMiles: [{ loadId: "L1", state: "OK" }],
    cards: [{ driverId: "d2", providerToken: "tok-p3", portalName: "POOL CARD 3", status: "active" as const }],
  };

  it("ranks a load through the state, then work that day, then a pool card, and drops the inactive", () => {
    const ranked = rankCandidates(posted, facts);
    expect(ranked.map((c) => [c.code, c.score, c.reasons])).toEqual([
      ["BR-D01", 3, ["on_load_in_state"]],
      ["BR-D02", 3, ["worked_that_day", "holds_pool_card"]],
      ["BR-D03", 2, ["worked_that_day"]],
    ]);
    expect(ranked.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(topIsTied(ranked)).toBe(true);
    expect(ranked[0].evidence).toEqual([{ day: "2026-10-20", loadId: "L1" }]);
  });

  it("has a clear top when one driver scores highest, and says when they are the only one", () => {
    const one = rankCandidates(posted, { ...facts, drivers: drivers.slice(0, 1) });
    expect(one.map((c) => c.reasons)).toEqual([["on_load_in_state", "only_candidate"]]);
    expect(topIsTied(one)).toBe(false);
    expect(rankCandidates(posted, { ...facts, drivers: [] })).toEqual([]);
  });

  it("reads the portal name's prefix without its trailing number", () => {
    expect(portalPrefix("POOL CARD 7")).toBe("POOL CARD");
    expect(portalPrefix("POOL CARD-12")).toBe("POOL CARD");
    expect(portalPrefix("BR-D07")).toBe("BR-D");
  });

  it("builds the match card's args with the whole amount and never the card's token", () => {
    const t: MatchTxn = {
      id: "t-9",
      providerRef: "ref-9",
      last4: "7781",
      portalName: "POOL CARD 7",
      postedOn: "2026-10-20",
      state: "OK",
      amountCents: 21_240,
      gallonsMilli: 52_850,
    };
    const ranked = rankCandidates(posted, facts);
    const args = matchArgs(t, ranked, ranked[0]);
    expect(args).toMatchObject({ transactionId: "t-9", amountCents: 21_240, driverId: "d1", driverCode: "BR-D01" });
    expect(JSON.stringify(args)).not.toContain("tok-");
  });
});
