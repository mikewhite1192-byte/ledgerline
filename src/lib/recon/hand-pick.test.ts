import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { cardReconHandler } from "../agent/gateway/__tests__/card-db";
import type { BreakView } from "../data/card-recon";
import type { Param, Queryable } from "../db";
import type { Candidate } from "../rules-engine/card-recon";
import { DEMO_CARRIERS } from "../seed/carriers";
import { buildCarrierPlan, type CarrierPlan } from "../seed/plan";
import type { LocalDate } from "../time/local-date";
import { handPickWhy, needsHandPick, readHandPick, workedLine } from "./view";
import { HAND_PICK_WORDS } from "./words";

// The list a card on no driver's file shows when no match card was made, on the real readers and
// the real ranking over the synthetic seed plans: no database, no model call, no write. Prairie
// Wind's planted card is the tie, a day nobody worked is the empty list, and Blue Ridge's card has
// one driver on top, so only the check's spent budget or a missing pick explains it.

const ANCHOR = "2026-11-02";
const blueRidge = buildCarrierPlan(DEMO_CARRIERS[0], ANCHOR);
const prairieWind = buildCarrierPlan(DEMO_CARRIERS[1], ANCHOR);
const saved = flags.cardRecon.enabled;
const RUN_CENTS = "JOIN card_recon_runs r";

beforeEach(() => {
  flags.cardRecon.enabled = true;
});

afterEach(() => {
  flags.cardRecon.enabled = saved;
});

// The plan's rows as the readers would get them, and what the check that last saw the card spent
// (null: no such check). Every read is recorded; a write fails the test.
function planQ(plan: CarrierPlan, runCents: number | null = null) {
  const reads: string[] = [];
  const handler = cardReconHandler(plan);
  const q: Queryable = {
    query: async <T,>(sql: string, params: Param[] = []): Promise<T[]> => {
      reads.push(sql);
      if (sql.includes(RUN_CENTS)) return (runCents === null ? [] : [{ model_cents: runCents }]) as T[];
      const out = handler(sql, params);
      if (out === undefined || typeof out === "number") throw new Error(`unexpected read: ${sql.slice(0, 60)}`);
      return out as T[];
    },
    execute: async () => {
      throw new Error("the list writes nothing");
    },
  };
  return { q, reads };
}

// The planted unknown card's difference, open and waiting on a person.
function unknownBreak(plan: CarrierPlan, over: Partial<BreakView> = {}): BreakView {
  const t = plan.rows.card_transactions.find((x) => x.id === plan.planted.cardRecon.cardUnknownId);
  if (!t) throw new Error("no planted unknown card");
  return {
    id: "5b0c4a0e-1d2e-4f3a-8b4c-5d6e7f8a9b0c",
    category: "card_unknown",
    severity: "high",
    outsideSystem: "fuel_card_sim",
    fixKind: "by_hand",
    status: "open",
    dismissCategory: null,
    ourCents: null,
    outsideCents: t.amount_cents,
    explanation: null,
    proposalId: null,
    transaction: {
      id: t.id,
      kind: "fuel",
      last4: t.card_last4,
      portalName: t.portal_name,
      postedOn: t.posted_on as LocalDate,
      state: t.state,
      gallonsMilli: t.gallons_milli,
      amountCents: t.amount_cents,
    },
    record: null,
    purchaseId: null,
    driver: null,
    firstSeenAt: "2026-11-02T17:00:00.000Z",
    updatedAt: "2026-11-02T17:00:00.000Z",
    ...over,
  };
}

const candidate = (code: string, score: number): Candidate => ({
  driverId: `d-${code}`,
  code,
  score,
  reasons: [score >= 3 ? "on_load_in_state" : "worked_that_day"],
  evidence: [{ day: "2026-10-30" as LocalDate, loadId: null }],
});

describe("a card on no driver's file that the check could not match", () => {
  it("shows Prairie Wind's planted card as a tie, with up to three drivers and no read of the check's spend", async () => {
    expect(prairieWind.planted.cardRecon.candidateDriverId).toBeNull();
    // Even a spent budget is not the reason: the tie came first.
    const { q, reads } = planQ(prairieWind, flags.cardRecon.limits.maxRunCents);
    const pick = await readHandPick(q, unknownBreak(prairieWind));
    expect(pick?.why).toBe("tied");
    expect(pick?.candidates.length).toBeGreaterThanOrEqual(2);
    expect(pick?.candidates.length).toBeLessThanOrEqual(3);
    expect(pick?.candidates[0].score).toBe(pick?.candidates[1].score);
    expect(new Set(pick?.candidates.map((c) => c.driverId)).size).toBe(pick?.candidates.length);
    expect(reads.some((sql) => sql.includes(RUN_CENTS))).toBe(false);
    expect(HAND_PICK_WORDS.tied).toBe("Two or more drivers fit this card equally well, so the check did not pick one.");
  });

  it("says no driver fits, with an empty list, on a day nobody worked", async () => {
    const brk = unknownBreak(prairieWind);
    const far = unknownBreak(prairieWind, { transaction: { ...brk.transaction!, postedOn: "2025-01-08" as LocalDate } });
    const { q, reads } = planQ(prairieWind, flags.cardRecon.limits.maxRunCents);
    const pick = await readHandPick(q, far);
    expect(pick).toEqual({ why: "none_fit", candidates: [] });
    expect(reads.some((sql) => sql.includes(RUN_CENTS))).toBe(false);
    expect(HAND_PICK_WORDS.none_fit).toBe("No driver fits: no active driver worked on that day or the day either side.");
  });

  it("names the spent budget only when one more pick would not fit, and otherwise that no driver was settled on", async () => {
    const top = blueRidge.planted.cardRecon.candidateDriverId;
    expect(top).not.toBeNull();
    const { matchMaxCents, maxRunCents } = flags.cardRecon.limits;
    const spent = await readHandPick(planQ(blueRidge, maxRunCents - matchMaxCents + 1).q, unknownBreak(blueRidge));
    expect(spent?.why).toBe("budget");
    expect(spent?.candidates[0].driverId).toBe(top);
    expect(spent?.candidates[0].score).toBeGreaterThan(spent?.candidates[1]?.score ?? 0);
    const room = await readHandPick(planQ(blueRidge, maxRunCents - matchMaxCents).q, unknownBreak(blueRidge));
    expect(room?.why).toBe("not_picked");
    const noRun = await readHandPick(planQ(blueRidge, null).q, unknownBreak(blueRidge));
    expect(noRun?.why).toBe("not_picked");
  });

  it("reads nothing while switched off, nor for a difference that is not waiting on a hand pick", async () => {
    const cases: BreakView[] = [
      unknownBreak(blueRidge, { status: "resolved" }),
      unknownBreak(blueRidge, { status: "dismissed", dismissCategory: "explained" }),
      unknownBreak(blueRidge, { fixKind: "card_match", proposalId: "6c1d5b1f-2e3f-4a4b-9c5d-6e7f8a9b0c1d" }),
      unknownBreak(blueRidge, { category: "purchase_not_recorded", fixKind: "by_hand" }),
      unknownBreak(blueRidge, { transaction: { ...unknownBreak(blueRidge).transaction!, kind: "load" } }),
      unknownBreak(blueRidge, { transaction: null }),
    ];
    for (const b of cases) {
      const { q, reads } = planQ(blueRidge);
      expect(await readHandPick(q, b)).toBeNull();
      expect(reads).toEqual([]);
    }
    flags.cardRecon.enabled = false;
    const { q, reads } = planQ(blueRidge);
    expect(await readHandPick(q, unknownBreak(blueRidge))).toBeNull();
    expect(reads).toEqual([]);
  });

  it("waits on a hand pick exactly when the page says By hand for an open unknown fuel card", () => {
    expect(needsHandPick(unknownBreak(blueRidge))).toBe(true);
    // A match card the check could not make reads "By hand" too.
    expect(needsHandPick(unknownBreak(blueRidge, { fixKind: "card_match", proposalId: null }))).toBe(true);
    expect(needsHandPick(unknownBreak(blueRidge, { fixKind: "card_match", proposalId: "p-1" }))).toBe(false);
    expect(needsHandPick(unknownBreak(blueRidge, { fixKind: "check_pending" }))).toBe(false);
  });

  it("puts an empty list before a tie, and a tie before the budget", () => {
    const limits = { matchMaxCents: 3, maxRunCents: 100 };
    expect(handPickWhy([], 100, limits)).toBe("none_fit");
    expect(handPickWhy([candidate("BR-D02", 2), candidate("BR-D05", 2)], 100, limits)).toBe("tied");
    expect(handPickWhy([candidate("BR-D02", 3), candidate("BR-D05", 2)], 98, limits)).toBe("budget");
    expect(handPickWhy([candidate("BR-D02", 3), candidate("BR-D05", 2)], 97, limits)).toBe("not_picked");
    expect(handPickWhy([candidate("BR-D02", 2)], null, limits)).toBe("not_picked");
  });

  it("writes the days that put a driver on the list in words, each once", () => {
    const at = (day: string) => ({ day });
    expect(workedLine([at("2026-10-30")])).toBe("Worked Oct 30, 2026");
    expect(workedLine([at("2026-10-29"), at("2026-10-30"), at("2026-10-30")])).toBe("Worked Oct 29, 2026 and Oct 30, 2026");
    expect(workedLine([at("2026-10-29"), at("2026-10-30"), at("2026-10-31")])).toBe(
      "Worked Oct 29, 2026, Oct 30, 2026 and Oct 31, 2026",
    );
    expect(workedLine([])).toBe("");
  });
});
