import type { Queryable } from "../db";
import { addDays, daysBetween, isLocalDate, type LocalDate } from "../time/local-date";
import { ESCROW_RELEASE_REMINDER_DAYS } from "./switches";

// The drivers due for an escrow release (design 3): terminated at least ninety days ago on the
// carrier's local dates, still holding a balance, with no release being sent, sent or not known
// yet. A read only: nothing is emailed or sent from it, so a driver terminated long before the
// switch went on is listed and nothing happens until a person approves a release.

export const DUE_LIST_MAX = 50;

export type DueRelease = {
  driverId: string;
  driverCode: string;
  activeTo: LocalDate;
  daysSince: number;
  balanceCents: number;
};

export type DueList = { asOf: LocalDate; drivers: DueRelease[]; truncated: boolean };

type Raw = { id: string; code: string; active_to: string; escrow_balance_cents: number | string };

// $1 the last active day that is due (today less the reminder days), $2 the row limit. Exported
// so a test's fake database can match the statement whole.
export const DUE_SQL = `SELECT CAST(d.id AS text) AS id, d.code, CAST(d.active_to AS text) AS active_to, d.escrow_balance_cents
       FROM drivers d
      WHERE d.tenant_id = current_tenant_id()
        AND d.active_to IS NOT NULL AND d.active_to <= CAST($1 AS date)
        AND d.escrow_balance_cents > 0
        AND NOT EXISTS (
          SELECT 1 FROM escrow_releases r
           WHERE r.tenant_id = d.tenant_id AND r.driver_id = d.id
             AND r.status IN ('issuing', 'released', 'unknown'))
      ORDER BY d.active_to, d.code
      LIMIT $2`;

// today: the carrier's local date of the request instant. The oldest termination first.
export async function listReleasesDue(q: Queryable, today: LocalDate): Promise<DueList> {
  if (!isLocalDate(today)) throw new RangeError("today is not a date");
  const cutoff = addDays(today, -ESCROW_RELEASE_REMINDER_DAYS);
  const rows = await q.query<Raw>(DUE_SQL, [cutoff, DUE_LIST_MAX + 1]);
  const drivers = rows.slice(0, DUE_LIST_MAX).map((r) => {
    const balance = Number(r.escrow_balance_cents);
    if (!Number.isSafeInteger(balance) || balance <= 0) throw new RangeError("escrow balance is not cents");
    if (!isLocalDate(r.active_to)) throw new RangeError("last active day is not a date");
    return {
      driverId: r.id,
      driverCode: r.code,
      activeTo: r.active_to,
      daysSince: daysBetween(r.active_to, today),
      balanceCents: balance,
    };
  });
  return { asOf: today, drivers, truncated: rows.length > DUE_LIST_MAX };
}
