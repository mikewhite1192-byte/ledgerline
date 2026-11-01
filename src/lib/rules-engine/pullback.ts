import { sub, sum } from "./money";
import type { Cents } from "./types";

// How much to pull back off a driver's fuel card. Pure: the caller reads the card's own records
// (src/lib/pullbacks/facts.ts) and the advance being taken back, and a person approves what this
// returns. The engine moves nothing.
//
// The card's balance is the engine's number from our own records, never the provider's: confirmed
// loads and hand loads on the statement, less the statement's fuel, less earlier confirmed pulls,
// never below zero. In test mode it is the only balance there is; a real provider would answer the
// same question through its adapter.
//
// Two cases:
//   a paid advance taken back (advance not null): pull the least of what was asked and the
//     balance. Nothing is short: what the card could not give back stays owed on the advance and
//     is recovered from pay as today.
//   a breakdown (advance null): pull the least of what was asked and the balance; what the card
//     could not give back is the shortfall, booked as a named deficit.
// Refusals, in this order: bad_request (an input not a safe integer, or nothing asked for),
// over_bound (asked for more than the take-back bound, or than the advance still owes; never
// trimmed to fit, so no deficit is booked for money still on the card), nothing_to_pull (the
// balance is zero), then over_bound again for a breakdown asking more than was loaded to the card
// and not pulled back yet, so no deficit is ever booked for money the card never received.

export const PULLBACK_REFUSALS = ["bad_request", "over_bound", "nothing_to_pull"] as const;
export type PullbackRefusal = (typeof PULLBACK_REFUSALS)[number];

export type PullbackBalance = {
  loadsCents: number;
  handLoadsCents: number;
  fuelCents: number;
  pulledCents: number;
};

export type PullbackInput = {
  requestedCents: number;
  maxCents: number;
  balance: PullbackBalance;
  advance: { stillOwedCents: number } | null;
};

export type PullbackPlan =
  | { ok: true; balanceCents: Cents; pullCents: Cents; shortfallCents: Cents }
  | { ok: false; refusal: PullbackRefusal };

const nonNegative = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

// The card's balance from its records, floored at zero. Throws on an input that is not whole cents.
export function cardBalanceCents(b: PullbackBalance): Cents {
  const held = sub(sum([b.loadsCents, b.handLoadsCents]), sum([b.fuelCents, b.pulledCents]));
  return (held > 0 ? held : 0) as Cents;
}

export function pullbackPlan(input: PullbackInput): PullbackPlan {
  const { requestedCents, maxCents, balance, advance } = input;
  if (
    !nonNegative(requestedCents) ||
    requestedCents === 0 ||
    !nonNegative(maxCents) ||
    !nonNegative(balance?.loadsCents) ||
    !nonNegative(balance.handLoadsCents) ||
    !nonNegative(balance.fuelCents) ||
    !nonNegative(balance.pulledCents) ||
    (advance !== null && !nonNegative(advance?.stillOwedCents))
  ) {
    return { ok: false, refusal: "bad_request" };
  }
  if (requestedCents > maxCents) return { ok: false, refusal: "over_bound" };
  if (advance !== null && requestedCents > advance.stillOwedCents) return { ok: false, refusal: "over_bound" };
  const balanceCents = cardBalanceCents(balance);
  if (balanceCents === 0) return { ok: false, refusal: "nothing_to_pull" };
  if (advance === null && requestedCents > sub(sum([balance.loadsCents, balance.handLoadsCents]), balance.pulledCents)) {
    return { ok: false, refusal: "over_bound" };
  }
  const pullCents = Math.min(requestedCents, balanceCents) as Cents;
  const shortfallCents = advance === null ? sub(requestedCents, pullCents) : (0 as Cents);
  return { ok: true, balanceCents, pullCents, shortfallCents };
}
