import { assertDate, assertOneOf, compareText, InputError } from "./types";

// Which pinned fuel or tax rate applies on a day (GROUNDED-RATES design 4.2). Pure: the caller
// reads the rows. Only a pin counts: a suggestion (looked up, never chosen) and a retired pin (one
// a later pin replaced) are never returned, whatever their dates. Of the live pins for the kind
// and state, the one with the latest effective date on or before the day; none is null, never a
// zero or a guess.

export const PINNED_RATE_KINDS = ["diesel_index", "ifta_rate"] as const;
export type PinnedRateKind = (typeof PINNED_RATE_KINDS)[number];

export type PinnedRate = {
  id: string;
  kind: string;
  // Two-letter state for a fuel tax rate; null for the national diesel price.
  state: string | null;
  status: string;
  // Thousandths of a cent per gallon.
  valueMcents: number | null;
  effectiveFrom: string | null;
  retiredAt: string | null;
};

export function rateOn(
  rates: readonly PinnedRate[],
  kind: PinnedRateKind,
  state: string | null,
  day: string,
): PinnedRate | null {
  assertOneOf(kind, PINNED_RATE_KINDS, "rate kind");
  assertDate(day, "rate day");
  if ((kind === "ifta_rate") !== (state !== null)) throw new InputError("rate state does not fit its kind");
  let best: PinnedRate | null = null;
  for (const r of rates) {
    if (r.status !== "pinned" || r.retiredAt !== null || r.kind !== kind || r.state !== state) continue;
    const from = assertDate(r.effectiveFrom, `pinned rate ${r.id} effective date`);
    if (!Number.isSafeInteger(r.valueMcents) || (r.valueMcents as number) <= 0) {
      throw new InputError(`pinned rate ${r.id} has no value`);
    }
    if (from > day) continue;
    if (
      best === null ||
      from > (best.effectiveFrom as string) ||
      (from === best.effectiveFrom && compareText(r.id, best.id) > 0)
    ) {
      best = r;
    }
  }
  return best;
}
