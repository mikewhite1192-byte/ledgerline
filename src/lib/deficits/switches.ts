import { flags } from "../../config/flags";
import { isLocalDate, type LocalDate } from "../time/local-date";

// The cancelled-trip switch (flags.cancelledTrip), read fresh on every call (never cached), so a
// switch turned off stops the next request. Asked by the staff move, the load-move executor, the
// route and the dispatch sync's withdrawn card.

export function cancelledTripEnabled(): boolean {
  return flags.cancelledTrip?.enabled === true;
}

// Whether a deficit card may be drafted or approved: the cancelled trip on, and deficit recovery on
// too (flags.deficitRecovery), both read fresh on every call (never cached). A deficit is only
// taken back from pay while deficit recovery is on, so with it off a booked deficit would move what
// the driver owes out of advance recovery into a line no pay run reads. Asked by the desk handler
// and the proposer that draft the deficit card, the executor registry, and the deficit executor
// and its precheck.
export function deficitBookEnabled(): boolean {
  return cancelledTripEnabled() && flags.deficitRecovery?.enabled === true;
}

// Whether a cancel on `day` (the carrier's local date) may be made or drafted. A start date that
// is not a real calendar date is unknown, so closed.
export function cancelledTripOn(day: LocalDate): boolean {
  const start = flags.cancelledTrip?.startDate;
  return cancelledTripEnabled() && isLocalDate(start) && isLocalDate(day) && day >= start;
}
