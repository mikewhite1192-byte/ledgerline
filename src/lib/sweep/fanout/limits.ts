import { flags, type Flags } from "../../../config/flags";
import type { Queryable } from "../../db";

// The second opinion's switch and the run-level spend helpers (design 3.7, layer 3).

export type FanoutLimits = Flags["fanoutLimits"];

// Read before every model call, not only when the run leaves find: every path to an outside call
// re-checks its own switch. The sweep and the model wrapper must be on too.
export function fanoutOn(): boolean {
  return flags.sweepEnabled === true && flags.fanoutEnabled === true && flags.aiEnabled === true;
}

export function fanoutLimits(): FanoutLimits {
  return flags.fanoutLimits;
}

const whole = (n: number) => Number.isSafeInteger(n) && n > 0;

// Holds cents against the run's cap before a call. The run must still be this worker's (its
// lease token) and the hold must fit: spent + reserved + cents <= cap. False: no call.
export async function reserveRunCents(q: Queryable, runId: string, leaseToken: string, cents: number): Promise<boolean> {
  if (!whole(cents)) return false;
  const rows = await q.query<{ id: string }>(
    `UPDATE sweep_runs SET reserved_cents = reserved_cents + $3
      WHERE id = CAST($1 AS uuid) AND lease_token = CAST($2 AS uuid) AND status = 'running'
        AND spent_cents + reserved_cents + $3 <= cap_cents
      RETURNING id`,
    [runId, leaseToken, cents],
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
      WHERE id = CAST($1 AS uuid) AND lease_token = CAST($2 AS uuid)`,
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
      WHERE (r.started_at AT TIME ZONE t.timezone)::date = (CAST($2 AS timestamptz) AT TIME ZONE t.timezone)::date`,
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
