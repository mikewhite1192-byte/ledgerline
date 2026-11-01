import { flags } from "../../config/flags";
import { isLocalDate, type LocalDate } from "../time/local-date";

// The cancelled-trip switch (flags.cancelledTrip), read fresh on every call (never cached), so a
// switch turned off stops the next request. Asked by the staff move, the load-move executor, the
// route, the dispatch sync's withdrawn card, the desk handler that drafts the deficit card and the
// deficit executor.

export function cancelledTripEnabled(): boolean {
  return flags.cancelledTrip?.enabled === true;
}

// Whether a cancel on `day` (the carrier's local date) may be made or drafted. A start date that
// is not a real calendar date is unknown, so closed.
export function cancelledTripOn(day: LocalDate): boolean {
  const start = flags.cancelledTrip?.startDate;
  return cancelledTripEnabled() && isLocalDate(start) && isLocalDate(day) && day >= start;
}
