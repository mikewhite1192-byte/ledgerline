import { describe, expect, it } from "vitest";
import type { FixLeg } from "../../../sweep/plan";
import { compareEngine, comparePayCorrection, ENGINE_UNAVAILABLE } from "./engine-check";

// The code-side engine check, per kind: a matched, a mismatched (one cent off is a mismatch) and an
// unavailable engine result. Whole values only; a refused or malformed result is never matched.

const AMOUNT = 12_345;

type Case = { kind: string; matched: Record<string, unknown>; mismatched: Record<string, unknown>; engineCents: number | null };

const CASES: Case[] = [
  {
    kind: "advance_payout",
    matched: { ok: true, eligible: true, approvedCents: AMOUNT },
    mismatched: { ok: true, eligible: true, approvedCents: AMOUNT - 1 },
    engineCents: AMOUNT,
  },
  {
    kind: "invoice_fix",
    matched: { ok: true, proposedCents: AMOUNT, engine: { ok: true, amountCents: AMOUNT } },
    mismatched: { ok: true, proposedCents: AMOUNT, engine: { ok: true, amountCents: AMOUNT + 1 } },
    engineCents: AMOUNT,
  },
  {
    kind: "invoice_post",
    matched: { ok: true, loadFound: true, engine: { ok: true, amountCents: AMOUNT }, matches: { amount: true, lines: true } },
    mismatched: { ok: true, loadFound: true, engine: { ok: true, amountCents: AMOUNT - 1 }, matches: { amount: true, lines: true } },
    engineCents: AMOUNT,
  },
  {
    kind: "load_rate_fill",
    matched: { ok: true, supported: true },
    mismatched: { ok: true, supported: false },
    engineCents: null,
  },
  {
    kind: "payment_reapply",
    matched: { ok: true, found: true, applicationCents: AMOUNT, applicationOnFromInvoice: true, findingMatches: true, findingCents: AMOUNT },
    mismatched: { ok: true, found: true, applicationCents: AMOUNT + 1, applicationOnFromInvoice: true, findingMatches: true, findingCents: AMOUNT },
    engineCents: AMOUNT,
  },
  {
    kind: "detention_charge",
    matched: { ok: true, engine: { ok: true, amountCents: AMOUNT, matchesProposal: true } },
    mismatched: { ok: true, engine: { ok: true, amountCents: AMOUNT - 1, matchesProposal: true } },
    engineCents: AMOUNT,
  },
  {
    kind: "settlement_approve",
    matched: { ok: true, found: true, status: "draft", engine: { ok: true, netCents: AMOUNT }, matches: { cardEqualsStored: true, storedEqualsEngine: true } },
    mismatched: { ok: true, found: true, status: "draft", engine: { ok: true, netCents: AMOUNT - 1 }, matches: { cardEqualsStored: true, storedEqualsEngine: false } },
    engineCents: AMOUNT,
  },
  {
    kind: "load_create",
    matched: { ok: true, check: "load_create", holds: true, totalCents: AMOUNT, linehaulCents: AMOUNT, fuelSurchargeCents: 0, accessorialCents: 0 },
    mismatched: { ok: true, check: "load_create", holds: true, totalCents: AMOUNT - 1, linehaulCents: AMOUNT - 1, fuelSurchargeCents: 0, accessorialCents: 0 },
    engineCents: AMOUNT,
  },
  {
    kind: "money_code",
    matched: { ok: true, check: "money_code", proposedCents: AMOUNT, engine: { ok: true, amountCents: AMOUNT, matchesProposal: true, reasons: [] } },
    mismatched: { ok: true, check: "money_code", proposedCents: AMOUNT, engine: { ok: true, amountCents: AMOUNT - 1, matchesProposal: false, reasons: [] } },
    engineCents: AMOUNT,
  },
];

describe("compareEngine", () => {
  it.each(CASES)("matches $kind only on whole equal values", ({ kind, matched, mismatched, engineCents }) => {
    expect(compareEngine(kind, AMOUNT, matched)).toEqual({ check: "matched", engineCents });
    expect(compareEngine(kind, AMOUNT, mismatched).check).toBe("mismatch");
    // The engine refused or could not run: unavailable, never matched.
    expect(compareEngine(kind, AMOUNT, { ...matched, ok: false })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine(kind, AMOUNT, { ok: false, error: "unavailable" })).toEqual(ENGINE_UNAVAILABLE);
  });

  // A paystub's card is compared with its stored draft inside the evidence (cardEqualsStored), from
  // the same stored amount, so it is not passed in again here.
  it("reads one cent off on the proposal's side as a mismatch too", () => {
    for (const { kind, matched } of CASES.filter((c) => c.engineCents !== null && c.kind !== "settlement_approve")) {
      expect(compareEngine(kind, AMOUNT + 1, matched).check, kind).toBe("mismatch");
    }
  });

  it("never matches on a missing, malformed or text figure", () => {
    expect(compareEngine("advance_payout", AMOUNT, { ok: true, eligible: true })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("advance_payout", AMOUNT, { ok: true, eligible: "true", approvedCents: AMOUNT })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("advance_payout", AMOUNT, { ok: true, eligible: true, approvedCents: "12345" })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("advance_payout", AMOUNT, { ok: true, eligible: true, approvedCents: 123.45 })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("invoice_fix", AMOUNT, { ok: true, proposedCents: AMOUNT, engine: { ok: false } })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("invoice_post", AMOUNT, { ok: true, engine: { ok: true, amountCents: AMOUNT } })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("load_rate_fill", AMOUNT, { ok: true })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("payment_reapply", AMOUNT, { ok: true, found: true })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("detention_charge", AMOUNT, { ok: true, engine: { ok: true } })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("advance_payout", Number.NaN, { ok: true, eligible: true, approvedCents: AMOUNT })).toEqual(ENGINE_UNAVAILABLE);
  });

  it("reads a match only when every flag is true, not truthy", () => {
    expect(compareEngine("invoice_post", AMOUNT, { ok: true, engine: { ok: true, amountCents: AMOUNT }, matches: { amount: 1, lines: true } }).check).toBe("mismatch");
    expect(compareEngine("detention_charge", AMOUNT, { ok: true, engine: { ok: true, amountCents: AMOUNT, matchesProposal: "yes" } }).check).toBe("mismatch");
    expect(compareEngine("advance_payout", AMOUNT, { ok: true, eligible: false, approvedCents: AMOUNT }).check).toBe("mismatch");
  });

  it("reads a record that is gone as a mismatch, and a paystub no longer a draft as unavailable", () => {
    expect(compareEngine("invoice_post", AMOUNT, { ok: true, loadFound: false })).toEqual({ check: "mismatch", engineCents: null });
    expect(compareEngine("payment_reapply", AMOUNT, { ok: true, found: false })).toEqual({ check: "mismatch", engineCents: null });
    expect(compareEngine("settlement_approve", AMOUNT, { ok: true, found: false })).toEqual({ check: "mismatch", engineCents: null });
    const approved = { ...CASES[6].matched, status: "approved" };
    expect(compareEngine("settlement_approve", AMOUNT, approved)).toEqual(ENGINE_UNAVAILABLE);
  });

  it("matches a load from a rate confirmation only while the checks still take the card's exact values", () => {
    const held = { ok: true, check: "load_create", holds: true, totalCents: AMOUNT };
    expect(compareEngine("load_create", AMOUNT, { ...held, holds: false })).toEqual({ check: "mismatch", engineCents: AMOUNT });
    expect(compareEngine("load_create", AMOUNT, { ...held, holds: "true" })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("load_create", AMOUNT, { ...held, totalCents: "12345" })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("load_create", AMOUNT, { ...held, totalCents: 123.45 })).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("load_create", AMOUNT, { ok: true, check: "load_create" })).toEqual(ENGINE_UNAVAILABLE);
  });

  it("has no comparison for the kinds merged after the design: unavailable", () => {
    for (const kind of ["factoring_request", "bill_defer", "collections_chase", "pay_rule_change", "card_match", "pay_correction"]) {
      expect(compareEngine(kind, AMOUNT, { ok: true, eligible: true, approvedCents: AMOUNT }), kind).toEqual(ENGINE_UNAVAILABLE);
    }
  });

  it("reads a money code the rules refused, or a malformed one, as unavailable, and a stale match as a mismatch", () => {
    const refused = { ok: true, check: "money_code", proposedCents: AMOUNT, engine: { ok: false, reason: "over_cap", refusals: [] } };
    expect(compareEngine("money_code", AMOUNT, refused)).toEqual(ENGINE_UNAVAILABLE);
    expect(compareEngine("money_code", AMOUNT, { ok: true, check: "money_code" })).toEqual(ENGINE_UNAVAILABLE);
    const text = { ok: true, engine: { ok: true, amountCents: "12345", matchesProposal: true } };
    expect(compareEngine("money_code", AMOUNT, text)).toEqual(ENGINE_UNAVAILABLE);
    const truthy = { ok: true, engine: { ok: true, amountCents: AMOUNT, matchesProposal: "yes" } };
    expect(compareEngine("money_code", AMOUNT, truthy).check).toBe("mismatch");
    // The engine's own flag says no although the figures agree: a mismatch.
    const no = { ok: true, engine: { ok: true, amountCents: AMOUNT, matchesProposal: false } };
    expect(compareEngine("money_code", AMOUNT, no)).toEqual({ check: "mismatch", engineCents: AMOUNT });
  });

  it("stores no engine figure the column cannot hold", () => {
    const big = compareEngine("advance_payout", 2_000_000_000, { ok: true, eligible: true, approvedCents: 2_000_000_000 });
    expect(big).toEqual(ENGINE_UNAVAILABLE);
    const negative = compareEngine("settlement_approve", AMOUNT, {
      ...CASES[6].matched,
      engine: { ok: true, netCents: -500 },
    });
    expect(negative).toEqual({ check: "matched", engineCents: null });
  });
});

const DRIVER = "0f6a3c1e-5b2d-4c8e-9a71-3d2e1f0b4a59";
const OTHER = "6b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

function leg(driverId: string, expectedCents: number): FixLeg {
  return {
    kind: "fix",
    leg: 1,
    driverId,
    expectedCents,
    verdict: expectedCents > 0 ? "owed_to_driver" : "owed_by_driver",
    reasonCategories: ["missed_stop_pay"] as unknown as FixLeg["reasonCategories"],
    sourceRefs: [],
  };
}

const owed = { subject_table: "drivers", subject_id: DRIVER, amount_cents: 4_500, direction: "out" as const };

describe("comparePayCorrection", () => {
  it("matches the sweep's own leg for the same driver, cents and sign", () => {
    expect(comparePayCorrection(owed, { driverId: DRIVER, deltaCents: 4_500 }, [leg(OTHER, 4_500), leg(DRIVER, 4_500)])).toEqual({
      check: "matched",
      engineCents: 4_500,
    });
    const taken = { ...owed, amount_cents: "3000", direction: "in" as const };
    expect(comparePayCorrection(taken, { driverId: DRIVER.toUpperCase(), deltaCents: -3_000 }, [leg(DRIVER, -3_000)]).check).toBe("matched");
  });

  it("reads one cent off, the wrong sign or the wrong stored row as a mismatch", () => {
    expect(comparePayCorrection(owed, { driverId: DRIVER, deltaCents: 4_500 }, [leg(DRIVER, 4_499)])).toEqual({
      check: "mismatch",
      engineCents: 4_499,
    });
    expect(comparePayCorrection(owed, { driverId: DRIVER, deltaCents: 4_500 }, [leg(DRIVER, -4_500)]).check).toBe("mismatch");
    expect(comparePayCorrection({ ...owed, amount_cents: 4_501 }, { driverId: DRIVER, deltaCents: 4_500 }, [leg(DRIVER, 4_500)]).check).toBe("mismatch");
    expect(comparePayCorrection({ ...owed, direction: "in" }, { driverId: DRIVER, deltaCents: 4_500 }, [leg(DRIVER, 4_500)]).check).toBe("mismatch");
    expect(comparePayCorrection({ ...owed, subject_id: OTHER }, { driverId: DRIVER, deltaCents: 4_500 }, [leg(DRIVER, 4_500)]).check).toBe("mismatch");
    // Two legs for the driver and neither equal: no single engine figure to store.
    expect(comparePayCorrection(owed, { driverId: DRIVER, deltaCents: 4_500 }, [leg(DRIVER, 100), leg(DRIVER, 200)])).toEqual({
      check: "mismatch",
      engineCents: null,
    });
  });

  it("is unavailable with no leg for the driver, or args that do not read whole", () => {
    expect(comparePayCorrection(owed, { driverId: DRIVER, deltaCents: 4_500 }, [leg(OTHER, 4_500)])).toEqual(ENGINE_UNAVAILABLE);
    expect(comparePayCorrection(owed, { driverId: DRIVER, deltaCents: 4_500 }, [])).toEqual(ENGINE_UNAVAILABLE);
    expect(comparePayCorrection(owed, { driverId: "D-07", deltaCents: 4_500 }, [leg(DRIVER, 4_500)])).toEqual(ENGINE_UNAVAILABLE);
    expect(comparePayCorrection(owed, { driverId: DRIVER, deltaCents: "4500" }, [leg(DRIVER, 4_500)])).toEqual(ENGINE_UNAVAILABLE);
    expect(comparePayCorrection(owed, { driverId: DRIVER, deltaCents: 45.5 }, [leg(DRIVER, 4_500)])).toEqual(ENGINE_UNAVAILABLE);
    expect(comparePayCorrection(owed, { driverId: DRIVER, deltaCents: 0 }, [leg(DRIVER, 0)])).toEqual(ENGINE_UNAVAILABLE);
  });
});
