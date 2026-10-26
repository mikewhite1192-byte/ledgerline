import type { Session } from "../auth/claims";
import { DbError, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { AiError, type AiFailureCategory, type AiProvider, type AiUsage } from "./types";

// The spend ledger (db/migrations/0002_ai_spend.sql). Reserve before the call, settle after, each
// in its own short transaction: a model call never sits inside a database transaction. Reads use
// SELECT only and writes check rows affected, because the Data API returns no rows for
// INSERT or UPDATE ... RETURNING.

type Counter = { spent_nanocents: number; reserved_nanocents: number; calls: number };

const LOCK_COUNTER =
  "SELECT spent_nanocents, reserved_nanocents, calls FROM ops.ai_spend WHERE id = 1 FOR UPDATE";

function checked(counter: Counter | undefined): Counter {
  // A missing row or a value that is not a safe integer is unknown, never zero.
  if (
    !counter ||
    !Number.isSafeInteger(counter.spent_nanocents) ||
    !Number.isSafeInteger(counter.reserved_nanocents) ||
    !Number.isSafeInteger(counter.calls)
  ) {
    throw new DbError("unknown");
  }
  return counter;
}

export type Reservation = {
  callId: string;
  provider: AiProvider;
  model: string;
  purpose: string;
  reserveNanocents: number;
  capNanocents: number;
};

// The counter's row lock serializes reservations: a second one waits for the first to commit,
// then sees its reservation. Two calls can never both pass the cap. Throws AiError("cap") with
// nothing written, or the tenant module's ForbiddenError when the session has no membership.
export async function reserve(db: TenantDb, session: Session, r: Reservation): Promise<void> {
  await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const counter = checked((await q.query<Counter>(LOCK_COUNTER))[0]);
    if (
      counter.spent_nanocents + counter.reserved_nanocents + r.reserveNanocents >
      r.capNanocents
    ) {
      throw new AiError("cap");
    }
    const inserted = await q.execute(
      `INSERT INTO ai_calls (id, tenant_id, provider, model, purpose, status, reserved_nanocents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, 'reserved', CAST($5 AS bigint))`,
      [r.callId, r.provider, r.model, r.purpose, r.reserveNanocents],
    );
    const updated = await q.execute(
      `UPDATE ops.ai_spend
          SET reserved_nanocents = reserved_nanocents + CAST($1 AS bigint), updated_at = now()
        WHERE id = 1`,
      [r.reserveNanocents],
    );
    if (inserted !== 1 || updated !== 1) throw new DbError("unknown");
  });
}

// answered: the provider reported usage, so the reservation is released and the real cost spent.
// refused: never charged, so the reservation is released and nothing spent.
// unknown: the reservation stays counted against the cap, forever (there is no usage read-back).
export type Settlement = { durationMs: number } & (
  | {
      kind: "answered";
      status: "ok" | "incomplete";
      usage: AiUsage;
      costNanocents: number;
      upstreamId: string | null;
      httpStatus: number;
    }
  | { kind: "refused"; category: AiFailureCategory; httpStatus: number }
  | { kind: "unknown"; category: AiFailureCategory; httpStatus: number | null }
);

// Settles one reserved row. The dedupe is the row's status: only a row still 'reserved' is
// settled, so a second settle of the same call changes nothing and returns false. The amount
// released is the one the row recorded, not one the caller passes. No membership check: the call
// already happened, and refusing to record it would only leave its reservation counted.
export async function settle(
  db: TenantDb,
  session: Session,
  callId: string,
  s: Settlement,
): Promise<boolean> {
  return db.withTenant(session.tenantId, async (q) => {
    const [row] = await q.query<{ reserved_nanocents: number }>(
      `SELECT reserved_nanocents FROM ai_calls
        WHERE id = CAST($1 AS uuid) AND status = 'reserved' FOR UPDATE`,
      [callId],
    );
    if (!row) return false;
    if (!Number.isSafeInteger(row.reserved_nanocents)) throw new DbError("unknown");

    const answered = s.kind === "answered" ? s : null;
    const updated = await q.execute(
      `UPDATE ai_calls
          SET status = $2, failure = $3, cost_nanocents = CAST($4 AS bigint),
              input_tokens = CAST($5 AS integer), cached_tokens = CAST($6 AS integer),
              output_tokens = CAST($7 AS integer), reasoning_tokens = CAST($8 AS integer),
              upstream_id = $9, http_status = CAST($10 AS smallint),
              duration_ms = CAST($11 AS integer), settled_at = now()
        WHERE id = CAST($1 AS uuid) AND status = 'reserved'`,
      [
        callId,
        answered ? answered.status : s.kind === "refused" ? "failed" : "unknown",
        s.kind === "answered" ? null : s.category,
        answered ? answered.costNanocents : s.kind === "refused" ? 0 : null,
        answered?.usage.input ?? null,
        answered?.usage.cached ?? null,
        answered?.usage.output ?? null,
        answered?.usage.reasoning ?? null,
        answered?.upstreamId ?? null,
        s.httpStatus,
        s.durationMs,
      ],
    );
    if (updated !== 1) throw new DbError("unknown");

    const release = s.kind === "unknown" ? 0 : row.reserved_nanocents;
    const spent = answered ? answered.costNanocents : 0;
    const counted = await q.execute(
      `UPDATE ops.ai_spend
          SET reserved_nanocents = reserved_nanocents - CAST($1 AS bigint),
              spent_nanocents = spent_nanocents + CAST($2 AS bigint),
              calls = calls + 1, updated_at = now()
        WHERE id = 1`,
      [release, spent],
    );
    if (counted !== 1) throw new DbError("unknown");
    return true;
  });
}

export type Spend = { spentNanocents: number; reservedNanocents: number; calls: number };

// The global counter. Any app transaction may read it; it holds no tenant's data.
export async function readSpend(q: Queryable): Promise<Spend> {
  const counter = checked(
    (
      await q.query<Counter>(
        "SELECT spent_nanocents, reserved_nanocents, calls FROM ops.ai_spend WHERE id = 1",
      )
    )[0],
  );
  return {
    spentNanocents: counter.spent_nanocents,
    reservedNanocents: counter.reserved_nanocents,
    calls: counter.calls,
  };
}

export type CallRow = {
  id: string;
  purpose: string;
  model: string;
  status: string;
  failure: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cost_nanocents: number | null;
  upstream_id: string | null;
  created_utc: string;
};

// This tenant's newest calls (row-level security limits them to the transaction's tenant).
export async function readRecentCalls(q: Queryable, limit: number): Promise<CallRow[]> {
  return q.query<CallRow>(
    `SELECT id, purpose, model, status, failure, input_tokens, output_tokens, reasoning_tokens,
            cost_nanocents, upstream_id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS created_utc
       FROM ai_calls
      WHERE tenant_id = current_tenant_id()
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
}
