import { describe, expect, it } from "vitest";
import { cardBalanceCents, pullbackPlan, type PullbackBalance, type PullbackInput } from "./pullback";

// A card that took $300.00 of payouts and $50.00 by hand, bought $75.00 of fuel and gave $25.00
// back earlier: it holds $250.00.
const HELD: PullbackBalance = { loadsCents: 30_000, handLoadsCents: 5_000, fuelCents: 7_500, pulledCents: 2_500 };

const input = (over: Partial<PullbackInput> = {}): PullbackInput => ({
  requestedCents: 20_000,
  maxCents: 100_000,
  balance: HELD,
  advance: null,
  ...over,
});

describe("the card pull-back plan", () => {
  it("reads the card's balance from its records, never below zero", () => {
    expect(cardBalanceCents(HELD)).toBe(25_000);
    expect(cardBalanceCents({ loadsCents: 1_000, handLoadsCents: 0, fuelCents: 4_000, pulledCents: 0 })).toBe(0);
    expect(() => cardBalanceCents({ ...HELD, fuelCents: 1.5 })).toThrow();
  });

  it("pulls a breakdown's whole ask when the card holds it", () => {
    expect(pullbackPlan(input())).toEqual({ ok: true, balanceCents: 25_000, pullCents: 20_000, shortfallCents: 0 });
  });

  it("pulls what a breakdown's card holds and names the rest as the shortfall", () => {
    expect(pullbackPlan(input({ requestedCents: 40_000 }))).toEqual({
      ok: true,
      balanceCents: 25_000,
      pullCents: 25_000,
      shortfallCents: 15_000,
    });
  });

  it("never names a shortfall on a take-back: what the card cannot give stays owed on the advance", () => {
    expect(pullbackPlan(input({ requestedCents: 30_000, advance: { stillOwedCents: 30_500 } }))).toEqual({
      ok: true,
      balanceCents: 25_000,
      pullCents: 25_000,
      shortfallCents: 0,
    });
  });

  it("refuses over the bound or what the advance still owes, never trimming to fit", () => {
    expect(pullbackPlan(input({ requestedCents: 100_001 }))).toEqual({ ok: false, refusal: "over_bound" });
    expect(pullbackPlan(input({ requestedCents: 30_501, advance: { stillOwedCents: 30_500 } }))).toEqual({
      ok: false,
      refusal: "over_bound",
    });
  });

  it("refuses an empty card and any input that is not whole cents", () => {
    expect(pullbackPlan(input({ balance: { ...HELD, pulledCents: 50_000 } }))).toEqual({ ok: false, refusal: "nothing_to_pull" });
    for (const over of [
      { requestedCents: 0 },
      { requestedCents: -1 },
      { requestedCents: 10.5 },
      { maxCents: Number.NaN },
      { balance: { ...HELD, loadsCents: -1 } },
      { advance: { stillOwedCents: 1.5 } },
    ] as Partial<PullbackInput>[]) {
      expect(pullbackPlan(input(over))).toEqual({ ok: false, refusal: "bad_request" });
    }
  });
});
