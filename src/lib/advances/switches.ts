import { flags } from "../../config/flags";
import { isLocalDate, type LocalDate } from "../time/local-date";

// The advance flow's switches, read fresh on every call (never cached), so a switch turned off
// stops the next request. The payout gate is asked before the ledger reserves a row, on approval
// and on every retry, and once more right before the money executor; the money executor and the
// payment adapter then check payoutsEnabled again at the write.

export type PayoutRefusal = "disabled" | "payouts_off" | "not_armed" | "over_cap" | "before_start";

export function advancesOn(): boolean {
  return flags.advancesEnabled === true;
}

// today: the tenant's local date of the request instant.
export function payoutGate(amountCents: number, today: LocalDate): PayoutRefusal | null {
  if (flags.advancesEnabled !== true) return "disabled";
  if (flags.payoutsEnabled !== true) return "payouts_off";
  const p = flags.advancePayouts;
  if (p?.armed !== true) return "not_armed";
  if (!Number.isSafeInteger(p.capCents) || !Number.isSafeInteger(amountCents) || amountCents > p.capCents) {
    return "over_cap";
  }
  // A start date that is not a real calendar date (2026-00-01, 2026-02-30) is unknown, so closed.
  if (!isLocalDate(p.startDate) || today < p.startDate) return "before_start";
  return null;
}
