import { flags, type Flags } from "../../../config/flags";
import { clampToMaxTurns } from "../../agent/run-limits";
import type { Queryable } from "../../db";
import { tenantLock } from "../../invoices/number";

// The second opinion's switch and the run-level spend helpers (design 3.7, layer 3).

export type FanoutLimits = Flags["fanoutLimits"];

// Read before every model call, not only when the run leaves find: every path to an outside call
// re-checks its own switch. The sweep and the model wrapper must be on too.
export function fanoutOn(): boolean {
  return flags.sweepEnabled === true && flags.fanoutEnabled === true && flags.aiEnabled === true;
}

// One driver check is one of the run's turns: the roster is never larger than the ceiling over
// every run (flags.runLimits.maxTurns), which only ever lowers maxDrivers.
export function fanoutLimits(): FanoutLimits {
  return { ...flags.fanoutLimits, maxDrivers: clampToMaxTurns(flags.fanoutLimits.maxDrivers) };
}

const whole = (n: number) => Number.isSafeInteger(n) && n > 0;

// A provider refusal the wrapper treats as definite: the hold was released and the ledger shows
// the call at 0. The status must match too: a 403 is also "auth", but its outcome is unknown and
// its reservation is kept, so it stays counted as the whole hold, like a timeout or a lost answer.
const REFUSED_WITH_STATUS: ReadonlyMap<string, number> = new Map([
  ["auth", 401],
  ["billing", 402],
  ["rate_limited", 429],
]);

export function refusedByProvider(category: string, httpStatus: number | undefined): boolean {
  return httpStatus !== undefined && REFUSED_WITH_STATUS.get(category) === httpStatus;
}

// The sweep spend counted (held included) by every run this carrier started on the same day, in
// its own time zone, as the run in `runParam`. A run counts in the day it started, so a run that
// goes on past midnight is held against that day's cap.
export function daySpentSql(runParam: string): string {
  return `(SELECT COALESCE(SUM(d.spent_cents + d.reserved_cents), 0)
             FROM sweep_runs d
             JOIN tenants t ON t.id = d.tenant_id
             JOIN sweep_runs me ON me.tenant_id = d.tenant_id AND me.id = CAST(${runParam} AS uuid)
            WHERE d.tenant_id = current_tenant_id()
              AND (d.started_at AT TIME ZONE t.timezone)::date = (me.started_at AT TIME ZONE t.timezone)::date)`;
}

// The carrier's day cap is shared by all its runs: their holds are taken one at a time. The lock
// is held to the end of the caller's transaction, so the next hold's read sees this one, and a
// caller that sizes a hold takes it before it reads the room.
export async function lockTenantDay(q: Queryable): Promise<void> {
  await tenantLock(q, "sweep_day_cents");
}

// Holds cents against the run's cap before a call. The run must still be this worker's (its
// lease token) and the hold must fit: spent + reserved + cents <= cap. The second opinion's own
// part must fit too: its spend (spent less the sweep's own) + reserved + cents <= cap less the
// sweep's own budget, so the explanations and audits that run after it always keep their whole
// budget. And the carrier's day cap: what all its runs that day counted and hold + cents <=
// tenantDayCents, checked under the carrier's lock so two runs at once cannot both pass it.
// False: no call.
export async function reserveRunCents(q: Queryable, runId: string, leaseToken: string, cents: number): Promise<boolean> {
  const dayCents = flags.fanoutLimits.tenantDayCents;
  if (!whole(cents) || !Number.isSafeInteger(dayCents)) return false;
  await lockTenantDay(q);
  const rows = await q.query<{ id: string }>(
    `UPDATE sweep_runs SET reserved_cents = reserved_cents + $3
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND lease_token = CAST($2 AS uuid)
        AND status = 'running' AND spent_cents + reserved_cents + $3 <= cap_cents
        AND (spent_cents - own_spent_cents) + reserved_cents + $3 <= cap_cents - $4
        AND ${daySpentSql("$1")} + $3 <= $5
      RETURNING id`,
    [runId, leaseToken, cents, flags.sweepLimits.maxRunCents, dayCents],
  );
  return rows.length === 1;
}

// Moves a hold to spent: the real cost when the outcome is known, the whole hold when it is not
// (an answer that never came back stays counted; rule 29). False when the lease moved, in which
// case the hold stays where it is and the run's end counts it as spent.
export async function settleRunCents(
  q: Queryable,
  runId: string,
  leaseToken: string,
  reservedCents: number,
  actualCents: number | null,
): Promise<boolean> {
  if (!whole(reservedCents)) return false;
  const actual = actualCents === null ? reservedCents : Math.max(0, Math.ceil(actualCents));
  if (!Number.isSafeInteger(actual)) return false;
  const n = await q.execute(
    `UPDATE sweep_runs
        SET reserved_cents = GREATEST(0, reserved_cents - $3), spent_cents = spent_cents + $4
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND lease_token = CAST($2 AS uuid)`,
    [runId, leaseToken, reservedCents, actual],
  );
  return n === 1;
}

// What this carrier's sweeps used today, in its own time zone: the runs that took the second
// opinion and the sweep spend counted (held included), this run left out of the run count.
export async function dayUse(
  q: Queryable,
  runId: string,
  now: Date,
): Promise<{ fanoutRuns: number; cents: number }> {
  const rows = await q.query<{ runs: number | string; cents: number | string | null }>(
    `SELECT COUNT(*) FILTER (WHERE r.fanout AND r.id <> CAST($1 AS uuid)) AS runs,
            COALESCE(SUM(r.spent_cents + r.reserved_cents), 0) AS cents
       FROM sweep_runs r JOIN tenants t ON t.id = r.tenant_id
      WHERE r.tenant_id = current_tenant_id()
        AND (r.started_at AT TIME ZONE t.timezone)::date = (CAST($2 AS timestamptz) AT TIME ZONE t.timezone)::date`,
    [runId, now.toISOString()],
  );
  const runs = Number(rows[0]?.runs);
  const cents = Number(rows[0]?.cents ?? 0);
  // Unknown is not zero: a count that does not read back counts as over the limit.
  if (!Number.isSafeInteger(runs) || !Number.isSafeInteger(cents)) {
    return { fanoutRuns: Number.MAX_SAFE_INTEGER, cents: Number.MAX_SAFE_INTEGER };
  }
  return { fanoutRuns: runs, cents };
}
