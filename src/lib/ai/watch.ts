import type { Session } from "../auth/claims";
import { DbError, type Queryable } from "../db";
import { ForbiddenError } from "../tenant/context";
import { NANOCENTS_PER_CENT } from "./prices";

// The spend watch: a per-job stop inside the overall budget (db/migrations/0026_spend_alerts.sql).
// reserve() in ./spend.ts calls checkJob under the counter's row lock, after the overall and
// Wonder caps and before the call's ledger row is written, so every model call passes through it
// and two calls of one job can never both pass. All times come from the database clock unless a
// test passes an instant (`at`); the app never reads the wall clock here.
//
// A job is one trace (the calls behind one answer) when the call has a trace, and otherwise the
// carrier's calls for one purpose that carry no trace. Its spend in the window is what each of its
// calls cost, or its reservation while the cost is not known (reserved, or unknown after a
// timeout): the same rule the overall counter follows, so unknown is never zero.

// The allowance as nanocents, or null when the flag is not a positive whole number of cents.
export function jobCapNanocents(cents: number): number | null {
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  const n = cents * NANOCENTS_PER_CENT;
  return Number.isSafeInteger(n) ? n : null;
}

// Whether a call fits its job's allowance. Reaching the allowance exactly is allowed.
export function withinAllowance(spent: number, reserve: number, cap: number): boolean {
  return spent + reserve <= cap;
}

export type JobCheck = {
  traceId: string | null;
  purpose: string;
  // The instant the window ends at, as an ISO string; null is the database clock (production).
  at: string | null;
  jobCapNanocents: number;
  reserveNanocents: number;
};

export type JobVerdict = "ok" | "job_cap";

type WindowRow = {
  open_alerts: number;
  window_start: string;
  window_end: string;
  spent_nanocents: number;
};

// The window ends now and starts 60 minutes earlier, or at the job's last clear when that is
// later, so a cleared job starts a fresh hour. It never starts after it ends. Microseconds are
// kept, so the bounds written to an alert are the ones the sum used. No upper bound on created_at:
// a row stamped later than the window's end still counts.
function windowSql(alertJob: string, callJob: string): string {
  return `WITH job_alerts AS (
       SELECT cleared_at FROM spend_alerts
        WHERE tenant_id = current_tenant_id() AND ${alertJob}
     ), bounds AS (
       SELECT COALESCE(CAST($2 AS timestamptz), now()) AS window_end,
              (SELECT count(*) FROM job_alerts WHERE cleared_at IS NULL) AS open_alerts,
              (SELECT max(cleared_at) FROM job_alerts) AS last_cleared
     ), win AS (
       SELECT window_end, open_alerts,
              LEAST(window_end,
                    GREATEST(window_end - interval '60 minutes',
                             COALESCE(last_cleared, window_end - interval '60 minutes'))) AS window_start
         FROM bounds
     )
     SELECT CAST(win.open_alerts AS integer) AS open_alerts,
            to_char(win.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
            to_char(win.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end,
            CAST(COALESCE((SELECT SUM(COALESCE(m.cost_nanocents, m.reserved_nanocents))
                             FROM model_calls m
                            WHERE m.tenant_id = current_tenant_id() AND ${callJob}
                              AND m.created_at > win.window_start), 0) AS bigint) AS spent_nanocents
       FROM win`;
}

const TRACE_WINDOW = windowSql("trace_id = CAST($1 AS uuid)", "m.trace_id = CAST($1 AS uuid)");
const PURPOSE_WINDOW = windowSql(
  "trace_id IS NULL AND purpose = $1",
  "m.trace_id IS NULL AND m.purpose = $1",
);

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function checkedWindow(row: WindowRow | undefined): WindowRow {
  // A missing row or a value that is not what the query makes is unknown, never zero.
  if (
    !row ||
    !Number.isSafeInteger(row.open_alerts) ||
    row.open_alerts < 0 ||
    !Number.isSafeInteger(row.spent_nanocents) ||
    row.spent_nanocents < 0 ||
    typeof row.window_start !== "string" ||
    typeof row.window_end !== "string" ||
    !ISO_INSTANT.test(row.window_start) ||
    !ISO_INSTANT.test(row.window_end)
  ) {
    throw new DbError("unknown");
  }
  return row;
}

// Inside reserve()'s transaction, under the counter lock. "job_cap" when the job has an alert
// nobody has cleared yet (nothing new is written), or when this call would take the job past its
// allowance: then one alert row is written, which commits with the transaction because reserve()
// returns the verdict instead of throwing. A read or write error throws (fail closed).
export async function checkJob(q: Queryable, c: JobCheck): Promise<JobVerdict> {
  if (!Number.isSafeInteger(c.jobCapNanocents) || c.jobCapNanocents <= 0) {
    throw new DbError("unknown");
  }
  const [row] = await q.query<WindowRow>(c.traceId === null ? PURPOSE_WINDOW : TRACE_WINDOW, [
    c.traceId ?? c.purpose,
    c.at,
  ]);
  const w = checkedWindow(row);
  if (w.open_alerts > 0) return "job_cap";
  if (withinAllowance(w.spent_nanocents, c.reserveNanocents, c.jobCapNanocents)) return "ok";
  const spent = w.spent_nanocents + c.reserveNanocents;
  if (!Number.isSafeInteger(spent)) throw new DbError("unknown");
  // ON CONFLICT: an open alert for the job already exists (it cannot under the counter lock, but a
  // second one is never written either way).
  const inserted = await q.execute(
    `INSERT INTO spend_alerts (tenant_id, trace_id, purpose, window_start, window_end,
                               spent_nanocents, limit_nanocents, created_at)
     VALUES (current_tenant_id(), CAST($1 AS uuid), $2, CAST($3 AS timestamptz),
             CAST($4 AS timestamptz), CAST($5 AS bigint), CAST($6 AS bigint),
             COALESCE(CAST($7 AS timestamptz), now()))
     ON CONFLICT DO NOTHING`,
    [c.traceId, c.purpose, w.window_start, w.window_end, spent, c.jobCapNanocents, c.at],
  );
  if (inserted !== 0 && inserted !== 1) throw new DbError("unknown");
  return "job_cap";
}

// --- The Meta models page ---

export type SpendAlert = {
  id: string;
  traceId: string | null;
  purpose: string;
  spentNanocents: number;
  limitNanocents: number;
  // ISO instants (UTC).
  createdAt: string;
  clearedAt: string | null;
  clearedByEmail: string | null;
};

type AlertRow = {
  id: string;
  trace_id: string | null;
  purpose: string;
  spent_nanocents: number;
  limit_nanocents: number;
  created_iso: string;
  cleared_iso: string | null;
  cleared_by_email: string | null;
};

// This carrier's alerts: every open one first, then the newest cleared ones, with who cleared
// each. Row-level security limits them to the transaction's tenant; the filter says so too.
export async function readSpendAlerts(q: Queryable, limit: number): Promise<SpendAlert[]> {
  const rows = await q.query<AlertRow>(
    `SELECT a.id, a.trace_id, a.purpose, a.spent_nanocents, a.limit_nanocents,
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_iso,
            to_char(a.cleared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cleared_iso,
            mb.email AS cleared_by_email
       FROM spend_alerts a
       LEFT JOIN memberships mb ON mb.tenant_id = a.tenant_id AND mb.id = a.cleared_by
      WHERE a.tenant_id = current_tenant_id()
      ORDER BY (a.cleared_at IS NULL) DESC, a.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => {
    if (!Number.isSafeInteger(r.spent_nanocents) || !Number.isSafeInteger(r.limit_nanocents)) {
      throw new DbError("unknown");
    }
    return {
      id: r.id,
      traceId: r.trace_id,
      purpose: r.purpose,
      spentNanocents: r.spent_nanocents,
      limitNanocents: r.limit_nanocents,
      createdAt: r.created_iso,
      clearedAt: r.cleared_iso,
      clearedByEmail: r.cleared_by_email,
    };
  });
}

export type DaySpend = { spentNanocents: number; calls: number };

// This carrier's model spend over the 24 hours before `at` (null: the database clock), counted the
// way the watch counts: the cost, or the reservation while the cost is not known.
export async function readDaySpend(q: Queryable, at: string | null): Promise<DaySpend> {
  const [row] = await q.query<{ spent_nanocents: number; calls: number }>(
    `SELECT CAST(COALESCE(SUM(COALESCE(cost_nanocents, reserved_nanocents)), 0) AS bigint) AS spent_nanocents,
            CAST(count(*) AS integer) AS calls
       FROM model_calls
      WHERE tenant_id = current_tenant_id()
        AND created_at > COALESCE(CAST($1 AS timestamptz), now()) - interval '24 hours'`,
    [at],
  );
  if (
    !row ||
    !Number.isSafeInteger(row.spent_nanocents) ||
    row.spent_nanocents < 0 ||
    !Number.isSafeInteger(row.calls) ||
    row.calls < 0
  ) {
    throw new DbError("unknown");
  }
  return { spentNanocents: row.spent_nanocents, calls: row.calls };
}

// This carrier's model spend since `at` (an instant), counted as readDaySpend counts it. The desk
// loop reads it before each piece of work to stop a wake that has spent its share.
export async function readSpendSince(q: Queryable, at: string): Promise<DaySpend> {
  const [row] = await q.query<{ spent_nanocents: number; calls: number }>(
    `SELECT CAST(COALESCE(SUM(COALESCE(cost_nanocents, reserved_nanocents)), 0) AS bigint) AS spent_nanocents,
            CAST(count(*) AS integer) AS calls
       FROM model_calls
      WHERE tenant_id = current_tenant_id()
        AND created_at >= CAST($1 AS timestamptz)`,
    [at],
  );
  if (
    !row ||
    !Number.isSafeInteger(row.spent_nanocents) ||
    row.spent_nanocents < 0 ||
    !Number.isSafeInteger(row.calls) ||
    row.calls < 0
  ) {
    throw new DbError("unknown");
  }
  return { spentNanocents: row.spent_nanocents, calls: row.calls };
}

export type ClearResult = "cleared" | "already_cleared" | "not_found";

// A person lets a stopped job run again. Admins only: anyone else gets ForbiddenError and nothing
// changes. The row records who (their membership) and when (`at`, null for the database clock).
// Only an open alert of this carrier is cleared; clearing one twice changes nothing.
export async function clearSpendAlert(
  q: Queryable,
  session: Session,
  alertId: string,
  at: string | null,
): Promise<ClearResult> {
  const members = await q.query<{ id: string; role: string }>(
    "SELECT id, role FROM memberships WHERE cognito_sub = $1",
    [session.sub],
  );
  if (members.length !== 1 || members[0].role !== "admin") throw new ForbiddenError();
  const updated = await q.execute(
    `UPDATE spend_alerts
        SET cleared_at = COALESCE(CAST($2 AS timestamptz), now()), cleared_by = CAST($3 AS uuid)
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND cleared_at IS NULL`,
    [alertId, at, members[0].id],
  );
  if (updated === 1) return "cleared";
  if (updated !== 0) throw new DbError("unknown");
  const found = await q.query<{ id: string }>(
    "SELECT id FROM spend_alerts WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()",
    [alertId],
  );
  return found.length === 1 ? "already_cleared" : "not_found";
}
