import type { Queryable } from "../../../db";

// The auditor's rows on a proposal (design 4.2 step 4). Inside a tenant transaction. Each write
// carries its own guard in the WHERE clause, so a second page load, a second tab or a retry
// changes nothing that is already set: the lease is taken by one caller at a time, and a verdict
// is written once (the database guard refuses any change after).

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type AuditState = {
  id: string;
  status: string;
  // Null on an engine proposal (origin 'engine'): no turn made it, so the evidence call has none.
  turnId: string | null;
  createdAt: string;
  verdict: string | null;
  concerns: string[];
  checkedAt: string | null;
  startedAt: string | null;
  traceId: string | null;
  timeZone: string;
};

type StateRow = {
  id: string;
  status: string;
  turn_id: string | null;
  created_at: string;
  auditor_verdict: string | null;
  auditor_concerns: string | null;
  auditor_checked_at: string | null;
  auditor_started_at: string | null;
  auditor_trace_id: string | null;
  timezone: string | null;
};

const CONCERN = /^[a-z_]{2,40}$/;

function concernsOf(text: string | null): string[] {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === "string" && CONCERN.test(c)) : [];
  } catch {
    return [];
  }
}

export async function readAuditState(q: Queryable, proposalId: string): Promise<AuditState | null> {
  const rows = await q.query<StateRow>(
    `SELECT p.id, p.status, p.turn_id, ${ISO("p.created_at")} AS created_at, p.auditor_verdict,
            CAST(p.auditor_concerns AS text) AS auditor_concerns,
            ${ISO("p.auditor_checked_at")} AS auditor_checked_at,
            ${ISO("p.auditor_started_at")} AS auditor_started_at,
            CAST(p.auditor_trace_id AS text) AS auditor_trace_id,
            (SELECT t.timezone FROM tenants t WHERE t.id = current_tenant_id()) AS timezone
       FROM proposals p
      WHERE p.tenant_id = current_tenant_id() AND p.id = CAST($1 AS uuid)`,
    [proposalId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    turnId: r.turn_id,
    createdAt: r.created_at,
    verdict: r.auditor_verdict,
    concerns: concernsOf(r.auditor_concerns),
    checkedAt: r.auditor_checked_at,
    startedAt: r.auditor_started_at,
    traceId: r.auditor_trace_id,
    timeZone: r.timezone ?? "UTC",
  };
}

export type AuditLease = { traceId: string; attempts: number };

// Takes the 90-second lease: only a waiting proposal with no verdict, whose lease is free or
// older than leaseMs. The same statement counts the attempt, so two callers never share a count.
// The audit's trace id is kept from the first lease, so a retry after a released lease joins the
// same trace. Returns that trace id and this attempt's number, or null when someone else holds it.
export async function takeAuditLease(
  q: Queryable,
  proposalId: string,
  now: Date,
  leaseMs: number,
  traceId: string,
): Promise<AuditLease | null> {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - leaseMs).toISOString();
  const rows = await q.query<{ trace_id: string | null; attempts: number | string | null }>(
    `UPDATE proposals
        SET auditor_started_at = CAST($2 AS timestamptz),
            auditor_trace_id = COALESCE(auditor_trace_id, CAST($3 AS uuid)),
            auditor_attempts = auditor_attempts + 1
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status = 'proposed' AND auditor_verdict IS NULL
        AND (auditor_started_at IS NULL OR auditor_started_at <= CAST($4 AS timestamptz))
      RETURNING CAST(auditor_trace_id AS text) AS trace_id, CAST(auditor_attempts AS integer) AS attempts`,
    [proposalId, nowIso, traceId, cutoff],
  );
  if (rows.length !== 1) return null;
  const attempts = Number(rows[0].attempts);
  // Unknown is not zero: an unreadable count throws, which rolls the lease back.
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("auditor: unreadable attempt count");
  return { traceId: rows[0].trace_id ?? traceId, attempts };
}

// Gives back this caller's own lease (the one it took at startedAt), so the page's one retry can
// audit again without waiting out the 90 seconds.
export async function releaseAuditLease(q: Queryable, proposalId: string, startedAt: Date): Promise<number> {
  return q.execute(
    `UPDATE proposals SET auditor_started_at = NULL
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND auditor_verdict IS NULL AND auditor_started_at = CAST($2 AS timestamptz)`,
    [proposalId, startedAt.toISOString()],
  );
}

export type VerdictWrite = {
  verdict: string;
  agrees: boolean | null;
  callId: string | null;
  concerns: readonly string[];
  // The carrier notes the evidence carried (carrierMemoryEnabled), by id. Absent means none, which
  // is the column's default.
  notesUsed?: readonly string[];
};

// Writes the verdict once, and only on a proposal still waiting, by the caller still holding the
// lease it took at startedAt. False when a verdict was already there (someone else finished
// first), the proposal was decided meanwhile, or this caller's lease lapsed and was taken over or
// given back (a lapsed lease's late answer never wins); the caller reads it back.
export async function writeAuditVerdict(
  q: Queryable,
  proposalId: string,
  v: VerdictWrite,
  now: Date,
  startedAt: Date,
): Promise<boolean> {
  const n = await q.execute(
    `UPDATE proposals
        SET auditor_verdict = $2, auditor_agrees = $3, auditor_call_id = CAST($4 AS uuid),
            auditor_concerns = CAST($5 AS jsonb), auditor_checked_at = CAST($6 AS timestamptz),
            updated_at = CAST($6 AS timestamptz), auditor_notes_used = CAST($8 AS jsonb)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND auditor_verdict IS NULL
        AND status = 'proposed' AND auditor_started_at = CAST($7 AS timestamptz)`,
    [
      proposalId,
      v.verdict,
      v.agrees,
      v.callId,
      JSON.stringify(v.concerns),
      now.toISOString(),
      startedAt.toISOString(),
      JSON.stringify(v.notesUsed ?? []),
    ],
  );
  return n === 1;
}

// Whether the code-side engine check is still to run: only on a proposal still waiting with none
// stored. Null when the proposal is not readable on this carrier.
export async function readEngineCheckDue(q: Queryable, proposalId: string): Promise<boolean | null> {
  const rows = await q.query<{ due: boolean }>(
    `SELECT (status = 'proposed' AND engine_check IS NULL) AS due
       FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [proposalId],
  );
  return rows[0] ? rows[0].due === true : null;
}

export type EngineCheckWrite = { check: "matched" | "mismatch" | "unavailable"; engineCents: number | null };

// Writes the engine check once, only on a proposal still waiting with none stored (the database
// refuses any change after, and any write outside proposed). A mismatch is also an exception on
// the proposal in the same statement, so no clean list (Approve all clean) ever holds it. False
// when one was already there or the proposal was decided meanwhile.
export async function writeEngineCheck(
  q: Queryable,
  proposalId: string,
  w: EngineCheckWrite,
  now: Date,
): Promise<boolean> {
  const n = await q.execute(
    `UPDATE proposals
        SET engine_check = CAST($2 AS text), engine_cents = CAST($3 AS bigint),
            engine_checked_at = CAST($4 AS timestamptz),
            exceptions = CASE WHEN CAST($2 AS text) = 'mismatch' AND NOT (exceptions ? 'engine_mismatch')
                              THEN exceptions || CAST('["engine_mismatch"]' AS jsonb) ELSE exceptions END,
            updated_at = CAST($4 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'proposed'
        AND engine_check IS NULL`,
    [proposalId, w.check, w.engineCents, now.toISOString()],
  );
  return n === 1;
}
