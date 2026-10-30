import { flags } from "../../config/flags";
import { isLocalDate, type LocalDate } from "../time/local-date";

// The escrow release switches, read fresh on every call (never cached), so a switch turned off
// stops the next request. The release gate is asked by the propose tool, by the precheck before
// the gate approves, again in the executor's transaction before the release row is written, and
// once more when the ledger row is reserved; the money executor then checks payoutsEnabled and the
// adapter at the write.

// A terminated driver is due for release this many days after their last active day, counted on
// the carrier's local dates.
export const ESCROW_RELEASE_REMINDER_DAYS = 90;

// Each word is the release's own, so an approval card can say it without taking another kind's
// sentence for the same idea.
export type ReleaseRefusal =
  | "escrow_off"
  | "escrow_payouts_off"
  | "escrow_not_armed"
  | "over_escrow_cap"
  | "escrow_before_start";

export function escrowReleaseOn(): boolean {
  return flags.escrowRelease?.enabled === true;
}

// today: the tenant's local date of the request instant. The cap is the most one release may be
// (inclusive).
export function escrowReleaseGate(amountCents: number, today: LocalDate): ReleaseRefusal | null {
  const e = flags.escrowRelease;
  if (e?.enabled !== true) return "escrow_off";
  if (flags.payoutsEnabled !== true) return "escrow_payouts_off";
  if (e.armed !== true) return "escrow_not_armed";
  if (!Number.isSafeInteger(e.capCents) || !Number.isSafeInteger(amountCents) || amountCents > e.capCents) {
    return "over_escrow_cap";
  }
  // A start date that is not a real calendar date is unknown, so closed.
  if (!isLocalDate(e.startDate) || today < e.startDate) return "escrow_before_start";
  return null;
}
