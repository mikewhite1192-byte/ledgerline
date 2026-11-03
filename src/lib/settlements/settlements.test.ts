import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { STAFF_ONLY_NOTE } from "../../components/app/staff-only";
import { doneNote } from "../../components/settlements/action-button";
import { reasonSentence } from "../agent/reasons";
import type { MoneyAction } from "../money/types";
import { cents as c, type SourceRef } from "../rules-engine";
import { checkBatch, legsToReserve, parseBatchRequest } from "./batch";
import { settlementIsClean } from "./clean";
import { batchStatusOf, countLegs } from "./drain";
import { linesHash } from "./hash";
import {
  exceptionLabel,
  LEG_NOT_SENT,
  legFailureLabel,
  parkLabel,
  PARK_LABELS,
  SETTLEMENT_OUTCOME_FALLBACK,
  SETTLEMENT_OUTCOMES,
  settlementOutcome,
} from "./labels";
import { latestOf, planLeg } from "./legs";
import { paidWritesOf } from "./paid";
import type { RetryResult } from "./post";
import {
  checkLineSources,
  parkReasonOf,
  PARK_REASONS,
  reconcileSettlement,
  rowKey,
  type ReconcileLine,
  type SourceRow,
} from "./reconcile";

// The pay run's pure parts: what counts as clean, the lines fingerprint, the batch checks, the
// drain's counts, the paid writes, and the check before an approve (13.4 goldens).

const saved = {
  ...flags,
  batchLimits: { ...flags.batchLimits },
  settlementLimits: { ...flags.settlementLimits },
};
afterEach(() => {
  Object.assign(flags, saved);
});

const ID = {
  a: "0b9a0c51-6e0b-4c1e-9a61-0f3c8f1d0a01",
  b: "0b9a0c51-6e0b-4c1e-9a61-0f3c8f1d0a02",
  c: "0b9a0c51-6e0b-4c1e-9a61-0f3c8f1d0a03",
  settlement: "5e771e00-0000-4000-8000-000000000001",
  other: "5e771e00-0000-4000-8000-000000000002",
};

describe("settlementIsClean", () => {
  const card = {
    status: "proposed",
    exceptions: [] as string[],
    flaggedInputId: null,
    auditorVerdict: "pass",
    auditorAgrees: true,
  };
  const draft = { status: "draft", net_cents: 52_500, parked_reason: null };

  it("is clean only with a clean card on an unparked draft that pays something", () => {
    expect(settlementIsClean(draft, card)).toBe(true);
    expect(settlementIsClean({ ...draft, net_cents: 0 }, card)).toBe(false);
    expect(settlementIsClean({ ...draft, status: "approved" }, card)).toBe(false);
    expect(settlementIsClean({ ...draft, parked_reason: "line_missing" }, card)).toBe(false);
    expect(settlementIsClean(draft, { ...card, exceptions: ["net_below_zero"] })).toBe(false);
    expect(settlementIsClean(draft, { ...card, auditorAgrees: null })).toBe(false);
    expect(settlementIsClean(draft, { ...card, auditorVerdict: "concerns" })).toBe(false);
    expect(settlementIsClean(draft, { ...card, flaggedInputId: ID.a })).toBe(false);
    expect(settlementIsClean(draft, { ...card, status: "approved" })).toBe(false);
  });
});

describe("linesHash", () => {
  const lines = [
    { kind: "load_pay", amountCents: 82_500, sources: [{ table: "loads" as const, id: ID.a }] },
    {
      kind: "fuel",
      amountCents: -28_640,
      sources: [
        { table: "pay_items" as const, id: ID.b },
        { table: "pay_items" as const, id: ID.c },
      ],
    },
  ];

  it("is the same for any order of lines or sources, and for upper-case ids", () => {
    const shuffled = [
      { ...lines[1], sources: [...lines[1].sources].reverse() },
      { ...lines[0], sources: [{ table: "loads" as const, id: ID.a.toUpperCase() }] },
    ];
    expect(linesHash(shuffled)).toBe(linesHash(lines));
    expect(linesHash(lines)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with any amount, kind or cited record", () => {
    const base = linesHash(lines);
    expect(linesHash([{ ...lines[0], amountCents: 83_000 }, lines[1]])).not.toBe(base);
    expect(linesHash([{ ...lines[0], kind: "accessorial" }, lines[1]])).not.toBe(base);
    expect(linesHash([{ ...lines[0], sources: [{ table: "loads", id: ID.b }] }, lines[1]])).not.toBe(base);
    expect(linesHash([lines[0]])).not.toBe(base);
  });
});

describe("the batch checks", () => {
  const limits = { maxItems: 3, maxTotalCents: 100_000 };
  const items = [
    { proposalId: ID.a, netCents: 40_000 },
    { proposalId: ID.b, netCents: 35_000 },
  ];

  it("passes exactly the sent ids with exactly the sent total", () => {
    expect(checkBatch(items, [ID.a, ID.b], 75_000, limits)).toBe(true);
    expect(checkBatch(items, [ID.b, ID.a], 75_000, limits)).toBe(true);
  });

  it("refuses a wrong total, a missing or extra id, a repeat, a $0 item and anything past a cap", () => {
    expect(checkBatch(items, [ID.a, ID.b], 75_001, limits)).toBe(false);
    expect(checkBatch(items, [ID.a], 40_000, limits)).toBe(false);
    expect(checkBatch(items, [ID.a, ID.b, ID.c], 75_000, limits)).toBe(false);
    expect(checkBatch(items, [ID.a, ID.a], 80_000, limits)).toBe(false);
    expect(checkBatch([...items, { proposalId: ID.c, netCents: 0 }], [ID.a, ID.b, ID.c], 75_000, limits)).toBe(
      false,
    );
    expect(checkBatch(items, [ID.a, ID.b], 75_000, { maxItems: 1, maxTotalCents: 100_000 })).toBe(false);
    expect(checkBatch(items, [ID.a, ID.b], 75_000, { maxItems: 3, maxTotalCents: 74_999 })).toBe(false);
    expect(checkBatch([], [], 0, limits)).toBe(false);
  });

  it("reads only a closed request with record ids, lowercased", () => {
    expect(parseBatchRequest({ periodId: ID.a, proposalIds: [ID.b.toUpperCase()], totalCents: 1 })).toEqual({
      periodId: ID.a,
      proposalIds: [ID.b],
      totalCents: 1,
    });
    expect(parseBatchRequest({ periodId: ID.a, proposalIds: [], totalCents: 1 })).toBeNull();
    expect(parseBatchRequest({ periodId: ID.a, proposalIds: [ID.b], totalCents: 1.5 })).toBeNull();
    expect(parseBatchRequest({ periodId: ID.a, proposalIds: ["Jane"], totalCents: 1 })).toBeNull();
    expect(parseBatchRequest({ periodId: ID.a, proposalIds: [ID.b], totalCents: 1, batchId: ID.c })).toBeNull();
  });

  it("reserves the payout only with payouts on, and the bill legs only with accounting on too", () => {
    flags.payoutsEnabled = false;
    flags.accountingEnabled = true;
    expect(legsToReserve()).toEqual([]);
    flags.payoutsEnabled = true;
    flags.accountingEnabled = false;
    expect(legsToReserve()).toEqual(["settlement_payout"]);
    flags.accountingEnabled = true;
    expect(legsToReserve()).toEqual(["settlement_payout", "settlement_bill", "settlement_bill_payment"]);
    // Payouts off for this carrier (Stripe test mode, not a demo carrier): nothing, as with the
    // switch off, since a bill never goes out before its payout.
    expect(legsToReserve(false)).toEqual([]);
  });
});

function action(over: Partial<MoneyAction>): MoneyAction {
  return {
    id: ID.a,
    tenantId: ID.b,
    kind: "settlement_payout",
    channel: "payment",
    subjectTable: "settlements",
    subjectId: ID.settlement,
    attempt: 1,
    idempotencyKey: "k",
    requestId: "r",
    amountCents: 100,
    counterpartyTable: "drivers",
    counterpartyId: ID.c,
    state: "reserved",
    failureCategory: null,
    settledVia: null,
    outsideSystem: null,
    outsideType: null,
    outsideId: null,
    outsideRef: null,
    outsideAmountCents: null,
    proposedBy: "person",
    proposalId: null,
    traceId: null,
    approverMembershipId: ID.c,
    batchId: null,
    checkCount: 0,
    createdAt: "2026-11-02T16:00:00.000Z",
    sentAt: null,
    settledAt: null,
    lastCheckedAt: null,
    ...over,
  } as MoneyAction;
}

describe("the drain's counts", () => {
  it("counts each leg by its state and is draining while anything is reserved or sent", () => {
    const rows = [
      action({ state: "confirmed" }),
      action({ state: "failed" }),
      action({ state: "unknown" }),
      action({ state: "reserved" }),
      action({ state: "sent" }),
    ];
    const counts = countLegs(rows, 2);
    expect(counts).toEqual({ sent: 2, confirmed: 1, failed: 1, unknown: 1, remaining: 2 });
    expect(batchStatusOf(counts)).toBe("draining");
  });

  it("is done when every leg is confirmed, and partial when one failed or is unknown", () => {
    expect(batchStatusOf(countLegs([action({ state: "confirmed" })], 1))).toBe("done");
    expect(batchStatusOf(countLegs([action({ state: "confirmed" }), action({ state: "failed" })], 0))).toBe(
      "partial",
    );
    expect(batchStatusOf(countLegs([action({ state: "unknown" })], 0))).toBe("partial");
    expect(batchStatusOf(countLegs([], 0))).toBe("done");
  });
});

describe("planning one leg", () => {
  it("starts at attempt 1, replays a reserved row, stops on confirmed or unknown", () => {
    expect(planLeg([], "settlement_bill", false)).toEqual({ go: true, attempt: 1 });
    expect(planLeg([action({ kind: "settlement_bill", attempt: 2 })], "settlement_bill", false)).toEqual({
      go: true,
      attempt: 2,
    });
    expect(planLeg([action({ kind: "settlement_bill", state: "confirmed" })], "settlement_bill", true)).toEqual({
      go: false,
      state: "confirmed",
    });
    expect(planLeg([action({ kind: "settlement_bill", state: "unknown" })], "settlement_bill", true)).toEqual({
      go: false,
      state: "unknown",
    });
  });

  it("tries a failed leg again only when asked, and never past the attempt cap", () => {
    const failed = (attempt: number) => action({ kind: "settlement_bill", state: "failed", attempt });
    expect(planLeg([failed(1)], "settlement_bill", false)).toEqual({ go: false, state: "failed" });
    expect(planLeg([failed(1)], "settlement_bill", true)).toEqual({ go: true, attempt: 2 });
    expect(planLeg([failed(1), failed(3)], "settlement_bill", true)).toEqual({ go: false, state: "attempts_used" });
    expect(latestOf([failed(1), failed(3), action({ kind: "settlement_payout", attempt: 9 })], "settlement_bill")?.attempt).toBe(3);
  });
});

describe("paidWritesOf", () => {
  const ref = (table: SourceRef["table"], id: string): SourceRef => ({ table, id });

  it("books escrow from the escrow line, each recovery, each cited item once, and the carry", () => {
    const w = paidWritesOf({
      settlementId: ID.settlement,
      lines: [
        { kind: "load_pay", amountCents: c(150_000), sources: [ref("loads", ID.a)] },
        { kind: "fuel", amountCents: c(-28_640), sources: [ref("pay_items", ID.b), ref("pay_items", ID.c)] },
        { kind: "reimbursement", amountCents: c(1_800), sources: [ref("pay_items", ID.b)] },
        { kind: "escrow", amountCents: c(-5_000), sources: [ref("deduction_schedules", ID.a)] },
        { kind: "advance_recovery", amountCents: c(-20_000), sources: [ref("advances", ID.c)] },
      ],
      carryForwardCents: c(0),
      openingCents: 120_000,
      periodEnd: "2026-11-01",
    });
    expect(w.escrow).toEqual({ openingCents: 120_000, chargesCents: 0, withheldCents: 5_000, closingCents: 125_000 });
    expect(w.escrowDeltaCents).toBe(5_000);
    expect(w.recoveries).toEqual([{ advanceId: ID.c, cents: 20_000 }]);
    expect(w.stampItemIds).toEqual([ID.b, ID.c]);
    expect(w.carried).toBeNull();
  });

  it("books each deficit recovery line against the one deficit it cites", () => {
    const w = paidWritesOf({
      settlementId: ID.settlement,
      lines: [
        { kind: "load_pay", amountCents: c(150_000), sources: [ref("loads", ID.a)] },
        { kind: "deficit_recovery", amountCents: c(-4_000), sources: [ref("driver_deficits", ID.b)] },
        { kind: "deficit_recovery", amountCents: c(-2_500), sources: [ref("driver_deficits", ID.c)] },
      ],
      carryForwardCents: c(0),
      openingCents: 0,
      periodEnd: "2026-11-01",
    });
    expect(w.deficitSettlements).toEqual([
      { deficitId: ID.b, cents: 4_000 },
      { deficitId: ID.c, cents: 2_500 },
    ]);
    expect(w.recoveries).toEqual([]);
    expect(w.stampItemIds).toEqual([]);
  });

  it("carries a shortfall into the next week's first day, citing the settlement", () => {
    const w = paidWritesOf({
      settlementId: ID.settlement,
      lines: [{ kind: "lease", amountCents: c(-35_000), sources: [ref("deduction_schedules", ID.a)] }],
      carryForwardCents: c(14_000),
      openingCents: 0,
      periodEnd: "2026-11-01",
    });
    expect(w.carried).toEqual({
      kind: "carried_shortfall",
      subkind: "shortfall",
      amountCents: 14_000,
      itemDate: "2026-11-02",
      refTable: "settlements",
      refId: ID.settlement,
      description: "Shortfall carried from the week before",
    });
    expect(w.escrow.withheldCents).toBe(0);
  });

  it("fails closed on a paystub it cannot book", () => {
    const base = { settlementId: ID.settlement, carryForwardCents: c(0), openingCents: 0, periodEnd: "2026-11-01" };
    const escrow = { kind: "escrow" as const, amountCents: c(-100), sources: [ref("deduction_schedules", ID.a)] };
    expect(() => paidWritesOf({ ...base, lines: [escrow, escrow] })).toThrow(RangeError);
    expect(() =>
      paidWritesOf({ ...base, lines: [{ ...escrow, kind: "advance_recovery", sources: [ref("loads", ID.a)] }] }),
    ).toThrow(RangeError);
    expect(() => paidWritesOf({ ...base, lines: [], openingCents: 1.5 })).toThrow(RangeError);
    const owed = { kind: "deficit_recovery" as const, amountCents: c(-100), sources: [ref("driver_deficits", ID.a)] };
    expect(() =>
      paidWritesOf({ ...base, lines: [{ ...owed, sources: [ref("driver_deficits", ID.a), ref("driver_deficits", ID.b)] }] }),
    ).toThrow(RangeError);
    expect(() => paidWritesOf({ ...base, lines: [{ ...owed, sources: [ref("advances", ID.a)] }] })).toThrow(RangeError);
    expect(() => paidWritesOf({ ...base, lines: [{ ...owed, amountCents: c(0) }] })).toThrow(RangeError);
  });
});

// 13.4's goldens: the stored draft against a fresh compute, then the cited records as they stand.
describe("the check before an approve", () => {
  const load = (id: string) => [{ table: "loads" as const, id }];
  const line = (kind: string, label: string, amountCents: number, sources: SourceRef[]): ReconcileLine => ({
    kind,
    label,
    amountCents,
    sources,
  });
  const LINES = [
    line("load_pay", "Load T-1", 82_500, load(ID.a)),
    line("reimbursement", "Toll", 1_800, [{ table: "pay_items", id: ID.b }]),
    line("lease", "Truck lease", -35_000, [{ table: "deduction_schedules", id: ID.c }]),
  ];
  const totals = (lines: ReconcileLine[]) => {
    const gross = lines.filter((l) => l.amountCents > 0).reduce((s, l) => s + l.amountCents, 0);
    const deductions = -lines.filter((l) => l.amountCents < 0).reduce((s, l) => s + l.amountCents, 0);
    return { grossCents: gross, deductionsCents: deductions, netCents: gross - deductions, carryForwardCents: 0 };
  };
  const paystub = (lines: ReconcileLine[]) => ({ ...totals(lines), lines });

  it("passes identical lines, and lines that only changed order", () => {
    expect(reconcileSettlement(paystub(LINES), paystub(LINES))).toEqual({ ok: true });
    expect(reconcileSettlement(paystub(LINES), paystub([...LINES].reverse()))).toEqual({ ok: true });
  });

  it("names a changed amount with both cents and the load", () => {
    const fresh = [line("load_pay", "Load T-1", 83_000, load(ID.a)), LINES[1], LINES[2]];
    const r = reconcileSettlement(paystub(LINES), paystub(fresh));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mismatches[0]).toEqual({
      category: "line_amount_changed",
      kind: "load_pay",
      storedCents: 82_500,
      freshCents: 83_000,
      sources: load(ID.a),
    });
    expect(parkReasonOf(r, [])).toBe("line_amount_changed");
  });

  it("names a missing line, an added line and changed totals with equal lines", () => {
    const missing = reconcileSettlement(paystub(LINES), { ...paystub(LINES), lines: [LINES[0], LINES[2]] });
    expect(!missing.ok && missing.mismatches[0].category).toBe("line_missing");
    const extra = line("accessorial", "Detention", 5_000, load(ID.a));
    const added = reconcileSettlement(paystub(LINES), { ...paystub(LINES), lines: [...LINES, extra] });
    expect(!added.ok && added.mismatches[0].category).toBe("line_added");
    const total = reconcileSettlement(paystub(LINES), { ...paystub(LINES), grossCents: 84_301 });
    expect(!total.ok && total.mismatches.map((m) => [m.category, m.field])).toEqual([
      ["total_changed", "grossCents"],
    ]);
  });

  it("names a line whose cited records changed once, not as a missing and an added line", () => {
    const moved = [line("load_pay", "Load T-1", 82_500, load(ID.b)), LINES[1], LINES[2]];
    const r = reconcileSettlement(paystub(LINES), paystub(moved));
    expect(!r.ok && r.mismatches.map((m) => m.category)).toEqual(["line_sources_changed"]);
  });

  const period = { start: "2026-10-26", end: "2026-11-01" };
  const loadRow = (status: string, deliveredOn: string | null): SourceRow =>
    ({ table: "loads", record: { status, deliveredOn } }) as unknown as SourceRow;
  const itemRow = (settlementId: string | null): SourceRow =>
    ({ table: "pay_items", record: { settlementId } }) as unknown as SourceRow;
  const advanceRow = (amount: number, recovered: number, takenBack = 0): SourceRow =>
    ({
      table: "advances",
      record: { status: "paid", amountCents: amount, feeCents: 0, recoveredCents: recovered, takenBackCents: takenBack },
    }) as unknown as SourceRow;

  it("finds each problem with a cited record as it stands now", () => {
    const lines = [
      line("load_pay", "Load T-1", 82_500, load(ID.a)),
      line("reimbursement", "Toll", 1_800, [{ table: "pay_items", id: ID.b }]),
      line("advance_recovery", "Advance", -20_000, [{ table: "advances", id: ID.c }]),
    ];
    const rows = (over: Record<string, SourceRow | null>) =>
      new Map<string, SourceRow | null>([
        [rowKey({ table: "loads", id: ID.a }), loadRow("delivered", "2026-10-28")],
        [rowKey({ table: "pay_items", id: ID.b }), itemRow(null)],
        [rowKey({ table: "advances", id: ID.c }), advanceRow(30_000, 0)],
        ...Object.entries(over),
      ]);
    expect(checkLineSources(lines, ID.settlement, period, rows({}))).toEqual([]);
    expect(checkLineSources(lines, ID.settlement, period, rows({ [`pay_items:${ID.b}`]: itemRow(ID.settlement) }))).toEqual(
      [],
    );
    const cat = (over: Record<string, SourceRow | null>) =>
      checkLineSources(lines, ID.settlement, period, rows(over)).map((p) => p.category);
    expect(cat({ [`pay_items:${ID.b}`]: itemRow(ID.other) })).toEqual(["source_settled_elsewhere"]);
    expect(cat({ [`loads:${ID.a}`]: loadRow("cancelled", "2026-10-28") })).toEqual(["source_changed"]);
    expect(cat({ [`loads:${ID.a}`]: loadRow("delivered", "2026-10-25") })).toEqual(["source_changed"]);
    expect(cat({ [`advances:${ID.c}`]: advanceRow(30_000, 15_000) })).toEqual(["advance_overrecovered"]);
    // A take-back a person recorded counts against what is left to recover, as settlements do.
    expect(cat({ [`advances:${ID.c}`]: advanceRow(30_000, 0, 15_000) })).toEqual(["advance_overrecovered"]);
    expect(cat({ [`advances:${ID.c}`]: null })).toEqual(["source_missing"]);
    // A record the server did not read at all counts as missing: unknown is not zero.
    expect(checkLineSources(lines, ID.settlement, period, new Map()).map((p) => p.category)).toEqual([
      "source_missing",
      "source_missing",
      "source_missing",
    ]);
    expect(parkReasonOf({ ok: true }, [{ category: "source_missing", source: load(ID.a)[0] }])).toBe("source_missing");
    expect(parkReasonOf({ ok: true }, [])).toBeNull();
  });
});

describe("the pay run's words", () => {
  it("has a label and an agent sentence for every reason a paystub can be parked", () => {
    for (const r of PARK_REASONS) {
      expect(PARK_LABELS[r], r).toBeTruthy();
      expect(parkLabel(r)).toBe(PARK_LABELS[r]);
      expect(reasonSentence(r), r).not.toBe("A rule check found this.");
    }
    expect(parkLabel("constructor")).toBe("This paystub needs a fresh run");
    expect(exceptionLabel("net_below_zero")).toBe("Deductions were more than pay; net is $0");
    expect(exceptionLabel("toString")).toBe("Needs a look");
    expect(settlementOutcome("no_payout")).toContain("net pay is $0");
    expect(settlementOutcome("hasOwnProperty")).toBe(SETTLEMENT_OUTCOME_FALLBACK);
  });

  it("answers a demo visitor's refused press (403 judge) with the staff-only line, never the fallback", () => {
    expect(settlementOutcome("judge")).toBe(STAFF_ONLY_NOTE);
  });

  it("never says nothing changed when the outcome is not known, and words every Retry payout refusal", () => {
    // A lost or unreadable reply (unknown), a server error (unavailable), or a category with no
    // sentence: the work may have happened, so none of them claims it did not.
    for (const category of ["unknown", "unavailable", "hasOwnProperty", "not_a_category", null, undefined]) {
      expect(settlementOutcome(category), String(category)).not.toMatch(/Nothing changed|Nothing was (sent|saved)/);
    }
    for (const category of ["unknown", "unavailable"]) {
      expect(settlementOutcome(category), category).toMatch(/^Not confirmed yet: this may have gone through\. Refresh the page/);
    }
    // Every category retryPayout answers has its own sentence, "failed" included.
    const refusals: Record<Extract<RetryResult, { ok: false }>["category"], true> = {
      disabled: true,
      not_found: true,
      not_approved: true,
      already_paid: true,
      in_flight: true,
      attempts_used: true,
      role: true,
      not_connected: true,
      not_configured: true,
      not_booked: true,
      records_changed: true,
      failed: true,
    };
    for (const category of Object.keys(refusals)) {
      expect(Object.hasOwn(SETTLEMENT_OUTCOMES, category), category).toBe(true);
    }
    expect(settlementOutcome("failed")).toBe(
      "The payout did not go out on this try. Check the money legs below before you try again.",
    );
  });

  it("says a bill leg the drain refused after the leg before it failed was not sent for that reason", () => {
    const batch = ID.a;
    const payoutFailed = action({ kind: "settlement_payout", state: "failed", failureCategory: "validation", settledVia: "response", batchId: batch });
    const refused = (kind: "settlement_bill" | "settlement_bill_payment", over: Partial<MoneyAction> = {}) =>
      action({ kind, state: "failed", failureCategory: "validation", settledVia: "refused", batchId: batch, ...over });
    const bill = refused("settlement_bill");
    const billPayment = refused("settlement_bill_payment");
    const rows = [payoutFailed, bill, billPayment];
    expect(legFailureLabel(bill, rows)).toBe(LEG_NOT_SENT);
    expect(legFailureLabel(billPayment, rows)).toBe(LEG_NOT_SENT);
    // The payout keeps its own category's words.
    expect(legFailureLabel(payoutFailed, rows)).toBeNull();

    // The leg before it was confirmed: refused for another reason (the connection answered validation).
    const payoutPaid = action({ kind: "settlement_payout", state: "confirmed", batchId: batch });
    expect(legFailureLabel(bill, [payoutPaid, bill])).toBeNull();
    // A failed payout in another batch, or none at all, says nothing about this one.
    expect(legFailureLabel(bill, [{ ...payoutFailed, batchId: ID.b }, bill])).toBeNull();
    expect(legFailureLabel(bill, [bill])).toBeNull();
    // Only the drain's refusal: not a send that failed, another category, a row from no batch, or a row not settled.
    expect(legFailureLabel(refused("settlement_bill", { settledVia: "response" }), rows)).toBeNull();
    expect(legFailureLabel(refused("settlement_bill", { failureCategory: "not_configured" }), rows)).toBeNull();
    expect(legFailureLabel(refused("settlement_bill", { batchId: null }), [{ ...payoutFailed, batchId: null }])).toBeNull();
    expect(legFailureLabel(refused("settlement_bill", { state: "reserved" }), rows)).toBeNull();
    // The latest attempt of the leg before it decides.
    const retried = action({ kind: "settlement_payout", state: "confirmed", attempt: 2, batchId: batch });
    expect(legFailureLabel(bill, [payoutFailed, retried, bill])).toBeNull();
  });

  it("says what a run, a post and a retry did, from counts and states only", () => {
    expect(doneNote("run", { counts: { drafts: 3, exceptions: 1, locked: 0, truncated: false } })).toBe(
      "3 paystubs drafted, 1 has exceptions.",
    );
    expect(doneNote("run", { counts: { drafts: 1, exceptions: 0, locked: 2, truncated: true } })).toBe(
      "1 paystub drafted, 2 already approved or paid. More drivers wait for the next run.",
    );
    expect(doneNote("run", {})).toBe("0 paystubs drafted.");
  });
});
