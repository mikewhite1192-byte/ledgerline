import type { Queryable } from "../db";
import { isLocalDate, type LocalDate } from "../time/local-date";

// Whether money may go to a driver on a day: armed (drivers.money_armed, 0027) AND active on that
// day, the rules engine's own meaning of active (advanceEligibility): on or after active_from and,
// when active_to is set, on or before it. A deactivated driver keeps their history (paystubs,
// advances, cards) and a pay run still settles what is owed; only new money is refused here.
//
// Asked by every gate that lets money out to a driver by name: the advance payout (precheck,
// executor, retry and the reserve's guarded update) and the money code (precheck and executor),
// each with the carrier's local date of its own instant. A date that does not read as a calendar
// date is unknown, so the driver reads as not active (fail closed).

export function activeOn(activeFrom: unknown, activeTo: unknown, day: LocalDate): boolean {
  if (!isLocalDate(day) || !isLocalDate(activeFrom)) return false;
  if (day < activeFrom) return false;
  if (activeTo === null) return true;
  return isLocalDate(activeTo) && day <= activeTo;
}

// What a money gate reads about the driver: null when there is no such driver in this carrier.
// Inactive is named before not armed: arming again would not help a driver who has left.
export type DriverMoneyState = "ok" | "not_armed" | "inactive";

export const DRIVER_MONEY_SQL =
  "SELECT money_armed, to_char(active_from, 'YYYY-MM-DD') AS active_from, to_char(active_to, 'YYYY-MM-DD') AS active_to" +
  " FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)";

type MoneyRow = { money_armed: boolean; active_from: string | null; active_to: string | null };

export function driverMoneyStateOf(row: MoneyRow, today: LocalDate): DriverMoneyState {
  if (!activeOn(row.active_from, row.active_to, today)) return "inactive";
  // Only true arms; the column is never null, and anything else reads as not armed.
  return row.money_armed === true ? "ok" : "not_armed";
}

// The driver's money state on `today` (the carrier's local date of the caller's instant). With
// lock, the driver row is held FOR UPDATE: arming and a status change take the same lock, so
// neither can change between this read and the caller's commit.
export async function readDriverMoneyState(
  q: Queryable,
  driverId: string,
  today: LocalDate,
  lock: boolean,
): Promise<DriverMoneyState | null> {
  const rows = await q.query<MoneyRow>(`${DRIVER_MONEY_SQL}${lock ? " FOR UPDATE" : ""}`, [driverId]);
  return rows.length === 1 ? driverMoneyStateOf(rows[0], today) : null;
}
