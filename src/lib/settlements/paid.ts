import { cents, sub, sum, type Cents, type LineKind, type SourceRef } from "../rules-engine";
import { addDays, type LocalDate } from "../time/local-date";

// The writes a paid settlement makes, worked out from its paystub lines alone (pure). The seed's
// history (applyHistory) and the live booking (bookPaidSettlement) both call this, so the two
// cannot drift: the settlement's escrow columns, the escrow delta on the driver, each recovery on
// its advance, each deficit recovery on its deficit, every pay item a line cites stamped with the settlement, and the shortfall carried
// into the next week as a carried_shortfall item.
//
// The lines are the source of truth on purpose. A live booking happens after the approval, when
// the driver's escrow balance or advances may have moved; the stored lines are what the person
// approved and what was paid, so the booking follows them, never a recompute.
//
// Escrow charges are not booked yet (charges 0): withheld is what the escrow line took.

export type PaidLine = {
  kind: LineKind;
  amountCents: Cents;
  sources: readonly SourceRef[];
};

export type CarriedItem = {
  kind: "carried_shortfall";
  subkind: "shortfall";
  amountCents: Cents;
  itemDate: LocalDate;
  refTable: "settlements";
  refId: string;
  description: string;
};

export type PaidWrites = {
  escrow: {
    openingCents: number;
    chargesCents: number;
    withheldCents: Cents;
    closingCents: number;
  };
  // Added to the driver's escrow balance.
  escrowDeltaCents: Cents;
  // One per advance_recovery line, in line order.
  recoveries: { advanceId: string; cents: Cents }[];
  // One per deficit_recovery line, in line order (0080).
  deficitSettlements: { deficitId: string; cents: Cents }[];
  // Every pay item a line cites, once each, in line order.
  stampItemIds: string[];
  carried: CarriedItem | null;
};

export const CARRIED_DESCRIPTION = "Shortfall carried from the week before";

export function paidWritesOf(input: {
  settlementId: string;
  lines: readonly PaidLine[];
  carryForwardCents: Cents;
  // The driver's escrow balance just before this booking.
  openingCents: number;
  periodEnd: LocalDate;
}): PaidWrites {
  if (!Number.isSafeInteger(input.openingCents)) throw new RangeError("opening balance is not cents");
  const escrowLines = input.lines.filter((l) => l.kind === "escrow");
  if (escrowLines.length > 1) throw new RangeError("a paystub has one escrow line at most");
  const withheld = escrowLines.length === 1 ? sub(0, escrowLines[0].amountCents) : cents(0);
  if (withheld < 0) throw new RangeError("an escrow line withholds, never pays out");

  const recoveries: PaidWrites["recoveries"] = [];
  for (const l of input.lines) {
    if (l.kind !== "advance_recovery") continue;
    const advances = l.sources.filter((s) => s.table === "advances");
    if (advances.length !== 1) throw new RangeError("a recovery line cites exactly one advance");
    const taken = sub(0, l.amountCents);
    if (taken <= 0) throw new RangeError("a recovery line takes money back");
    recoveries.push({ advanceId: advances[0].id, cents: taken });
  }

  const deficitSettlements: PaidWrites["deficitSettlements"] = [];
  for (const l of input.lines) {
    if (l.kind !== "deficit_recovery") continue;
    if (l.sources.length !== 1 || l.sources[0].table !== "driver_deficits") {
      throw new RangeError("a deficit recovery line cites exactly one deficit");
    }
    const taken = sub(0, l.amountCents);
    if (taken <= 0) throw new RangeError("a deficit recovery line takes money back");
    deficitSettlements.push({ deficitId: l.sources[0].id, cents: taken });
  }

  const stamp: string[] = [];
  const seen = new Set<string>();
  for (const l of input.lines) {
    for (const s of l.sources) {
      if (s.table !== "pay_items" || seen.has(s.id)) continue;
      seen.add(s.id);
      stamp.push(s.id);
    }
  }

  const closing = sum([input.openingCents, withheld]);
  return {
    escrow: {
      openingCents: input.openingCents,
      chargesCents: 0,
      withheldCents: withheld,
      closingCents: closing,
    },
    escrowDeltaCents: withheld,
    recoveries,
    deficitSettlements,
    stampItemIds: stamp,
    carried:
      input.carryForwardCents > 0
        ? {
            kind: "carried_shortfall",
            subkind: "shortfall",
            amountCents: input.carryForwardCents,
            // Pay periods are whole weeks back to back, so the next one starts the day after.
            itemDate: addDays(input.periodEnd, 1),
            refTable: "settlements",
            refId: input.settlementId,
            description: CARRIED_DESCRIPTION,
          }
        : null,
  };
}
