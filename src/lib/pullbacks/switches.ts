import { flags } from "../../config/flags";
import { isLocalDate, type LocalDate } from "../time/local-date";

// The card pull-back switches, read fresh on every call (never cached), so a switch turned off
// stops the next request. The pull gate is asked by the propose tool, the take-back, the precheck
// before the gate approves, the executor before the pull row is written, the ledger's reserve and
// send; the money executor and the simulated card provider then check payoutsEnabled again at the
// write.

export type PullRefusal = "pullback_off" | "pullback_payouts_off" | "pullback_before_start";

// The feature itself: the pull-back switch and the take-back it extends.
export function pullbackOn(): boolean {
  return flags.cardPullback?.enabled === true && flags.advanceTakeback?.enabled === true;
}

// createdOn: the carrier's local date the proposal was made. A card made before the start date is
// refused, so turning the switch on never acts on an older card.
export function pullGate(createdOn: LocalDate): PullRefusal | null {
  if (!pullbackOn()) return "pullback_off";
  if (flags.payoutsEnabled !== true) return "pullback_payouts_off";
  // A start date that is not a real calendar date is unknown, so closed.
  const start = flags.cardPullback.startDate;
  if (!isLocalDate(start) || !isLocalDate(createdOn) || createdOn < start) return "pullback_before_start";
  return null;
}
