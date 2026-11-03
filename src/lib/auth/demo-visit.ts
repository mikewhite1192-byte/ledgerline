import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Flags } from "../../config/flags";
import { DbError, type Queryable } from "../db";
import { isRole, type Role } from "../roles";
import { isUuid } from "../uuid";

// A demo visit: one demo_sessions row (db/migrations/0043_judge_role.sql) that a judge's model
// spend and agent turns hang on. Every function here runs inside a transaction already scoped to
// the visit's tenant, so row-level security limits it to that carrier's visits. Reads use SELECT
// and writes check rows affected, because the Data API returns no rows for UPDATE ... RETURNING.
// This module never imports src/lib/tenant/context.ts: src/lib/auth/session.ts uses it, and the
// tenant module imports the session.
//
// Instants: `at` is an ISO instant the tests pass; production passes null, the database clock.

export type VisitLimits = Omit<Flags["judgeAccess"], "enabled">;

export const NANOCENTS_PER_CENT = 1_000_000_000;

// The start of the UTC day `at` falls in, as SQL over one parameter.
const DAY_START = (p: string) =>
  `(date_trunc('day', COALESCE(CAST(${p} AS timestamptz), now()) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
const AT = (p: string) => `COALESCE(CAST(${p} AS timestamptz), now())`;

// The visitor's address, hashed with a salt made fresh in each server process, so the raw address
// is never stored and a stored hash cannot be matched back to an address. Approximate across
// instances (each has its own salt). The hash is of the first X-Forwarded-For entry, which the
// client can set (CloudFront adds the address it saw after any value the client sent), so the
// per-address limit is best-effort: a script that sends a fresh value on each click passes it, and
// meets the limits across every address (sessionsPerHour, sessionsPerDay) instead. Anything that
// does not look like an IPv4 or IPv6 address is no address (null, and every null shares one bucket).
const SALT = randomBytes(32);
const ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/;

export function ipHashOf(forwardedFor: string | null | undefined): string | null {
  const first = forwardedFor?.split(",")[0]?.trim() ?? "";
  if (!ADDRESS.test(first)) return null;
  return createHash("sha256").update(SALT).update(first.toLowerCase(), "utf8").digest("hex");
}

export type StartVisitInput = {
  sub: string;
  ipHash: string | null;
  // The pc_demo cookie's value, when the browser sent one.
  reuseId: string | null;
  limits: VisitLimits;
  at?: string | null;
};

export type VisitRefusal = "day_cap" | "ip_limit" | "day_limit" | "hour_limit";

export type StartedVisit = { ok: true; id: string; reused: boolean } | { ok: false; reason: VisitRefusal };

// The visit a sign-in uses. In order: the day's spend across every visit (no room means no visit,
// new or kept, since no model call could run), a live visit the browser already holds (a second
// click or a new tab shares it, and its budget), the new-visit limits per address per hour, per
// day and per rolling hour across every address, then a new row. Two sign-ins racing past a count
// can both get in; the counts are a brake on scripts, not a ledger (the spend caps are enforced
// under the spend lock). The day bucket keys on each visit's created_at, so a visit started just
// before midnight UTC counts in the day it started, its spend included.
export async function startVisit(q: Queryable, input: StartVisitInput): Promise<StartedVisit> {
  const at = input.at ?? null;
  const { limits } = input;
  const [day] = await q.query<{ used: number }>(
    `SELECT CAST(COALESCE(SUM(spent_nanocents + reserved_nanocents), 0) AS bigint) AS used
       FROM demo_sessions
      WHERE tenant_id = current_tenant_id() AND created_at >= ${DAY_START("$1")}`,
    [at],
  );
  if (!day || !Number.isSafeInteger(day.used)) throw new DbError("unknown");
  if (day.used >= limits.dayCapCents * NANOCENTS_PER_CENT) return { ok: false, reason: "day_cap" };

  if (input.reuseId !== null && isUuid(input.reuseId)) {
    const live = await q.query<{ id: string }>(
      `SELECT id FROM demo_sessions
        WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND cognito_sub = $2
          AND expires_at > ${AT("$3")}`,
      [input.reuseId, input.sub, at],
    );
    if (live.length === 1) return { ok: true, id: live[0].id, reused: true };
  }

  const [address] = await q.query<{ n: number }>(
    `SELECT CAST(COUNT(*) AS integer) AS n FROM demo_sessions
      WHERE tenant_id = current_tenant_id() AND ip_hash IS NOT DISTINCT FROM $1
        AND created_at > ${AT("$2")} - interval '1 hour'`,
    [input.ipHash, at],
  );
  if (!address || !Number.isSafeInteger(address.n)) throw new DbError("unknown");
  if (address.n >= limits.sessionsPerIpPerHour) return { ok: false, reason: "ip_limit" };

  const [today] = await q.query<{ n: number }>(
    `SELECT CAST(COUNT(*) AS integer) AS n FROM demo_sessions
      WHERE tenant_id = current_tenant_id() AND created_at >= ${DAY_START("$1")}`,
    [at],
  );
  if (!today || !Number.isSafeInteger(today.n)) throw new DbError("unknown");
  if (today.n >= limits.sessionsPerDay) return { ok: false, reason: "day_limit" };

  // Every address together, in the rolling hour: no header is read, so a fresh X-Forwarded-For on
  // each click does not get past it.
  const [hour] = await q.query<{ n: number }>(
    `SELECT CAST(COUNT(*) AS integer) AS n FROM demo_sessions
      WHERE tenant_id = current_tenant_id() AND created_at > ${AT("$1")} - interval '1 hour'`,
    [at],
  );
  if (!hour || !Number.isSafeInteger(hour.n)) throw new DbError("unknown");
  if (hour.n >= limits.sessionsPerHour) return { ok: false, reason: "hour_limit" };

  const seconds = Math.floor(limits.cookieHours * 60 * 60);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new DbError("unknown");
  const id = randomUUID();
  const inserted = await q.execute(
    `INSERT INTO demo_sessions (id, tenant_id, cognito_sub, created_at, last_seen_at, expires_at, ip_hash)
     VALUES (CAST($1 AS uuid), current_tenant_id(), $2, ${AT("$3")}, ${AT("$3")},
             ${AT("$3")} + CAST($4 AS integer) * interval '1 second', $5)`,
    [id, input.sub, at, seconds, input.ipHash],
  );
  if (inserted !== 1) throw new DbError("unknown");
  return { ok: true, id, reused: false };
}

// What getSession() needs about a pc_demo cookie: the signed-in subject's one role in the tenant,
// whether the named visit is theirs and still live, and the copy of the demo carrier the visit
// points at (0091, flags.visitCopies), if any. No membership row (or more than one, or a role this
// code does not know) is role null. A visit that is not this subject's is not live and has no
// copy.
export type VisitCopy = {
  // The copy carrier's tenants.id and the visit row inside it (spend and turns are counted there).
  tenantId: string;
  sessionId: string;
  ready: boolean;
  deleted: boolean;
  // The visit's expiry, an ISO instant in UTC: the copy's own visit row ends with it.
  expiresAt: string;
};

export type VisitRead = { role: Role | null; live: boolean; copy: VisitCopy | null };

type VisitRow = {
  role: unknown;
  live: unknown;
  copy_tenant_id?: unknown;
  copy_session_id?: unknown;
  copy_ready?: unknown;
  copy_deleted?: unknown;
  expires_at?: unknown;
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

// The copy columns of one read row. Neither id set is no copy. Both set, with the flags and the
// expiry in their shapes, is the copy. Anything else (one id, a malformed value) is unknown and
// throws, so the caller fails closed.
function copyOf(row: VisitRow): VisitCopy | null {
  const tenant = row.copy_tenant_id ?? null;
  const session = row.copy_session_id ?? null;
  if (tenant === null && session === null) return null;
  if (!isUuid(tenant) || !isUuid(session)) throw new DbError("unknown");
  if (typeof row.copy_ready !== "boolean" || typeof row.copy_deleted !== "boolean") throw new DbError("unknown");
  if (typeof row.expires_at !== "string" || !ISO_UTC.test(row.expires_at)) throw new DbError("unknown");
  return {
    tenantId: tenant.toLowerCase(),
    sessionId: session.toLowerCase(),
    ready: row.copy_ready,
    deleted: row.copy_deleted,
    expiresAt: row.expires_at,
  };
}

// The visit's expiry as an ISO instant in UTC, whatever the driver does with timestamptz.
const EXPIRES_AT_SQL = `to_char(d.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function readVisit(q: Queryable, sub: string, visitId: string): Promise<VisitRead> {
  if (!isUuid(visitId)) return { role: null, live: false, copy: null };
  const rows = await q.query<VisitRow>(
    `SELECT m.role,
            (d.id IS NOT NULL AND d.expires_at > now()) AS live,
            d.copy_tenant_id, d.copy_session_id,
            CASE WHEN d.id IS NULL THEN NULL ELSE d.copy_ready_at IS NOT NULL END AS copy_ready,
            CASE WHEN d.id IS NULL THEN NULL ELSE d.copy_deleted_at IS NOT NULL END AS copy_deleted,
            ${EXPIRES_AT_SQL} AS expires_at
       FROM memberships m
       LEFT JOIN demo_sessions d
              ON d.id = CAST($2 AS uuid) AND d.tenant_id = current_tenant_id()
             AND d.cognito_sub = m.cognito_sub
      WHERE m.tenant_id = current_tenant_id() AND m.cognito_sub = $1`,
    [sub, visitId],
  );
  if (rows.length !== 1 || !isRole(rows[0].role)) return { role: null, live: false, copy: null };
  return { role: rows[0].role, live: rows[0].live === true, copy: copyOf(rows[0]) };
}

// The sign-in's claim of a copy for its visit (flags.visitCopies): one guarded write gives the
// live visit, this subject's, the two fresh ids, only while it has none. "claimed" is that write;
// "kept" is a visit that already had its copy (a second click reuses the visit and its copy).
// Anything else (the visit gone, ended, someone else's) is refused, and nothing was written.
export type CopyClaim = "claimed" | "kept" | "refused";

export async function claimCopy(
  q: Queryable,
  input: { visitId: string; sub: string; copyTenantId: string; copySessionId: string },
): Promise<CopyClaim> {
  if (!isUuid(input.visitId) || !isUuid(input.copyTenantId) || !isUuid(input.copySessionId)) return "refused";
  const updated = await q.execute(
    `UPDATE demo_sessions
        SET copy_tenant_id = CAST($3 AS uuid), copy_session_id = CAST($4 AS uuid)
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND cognito_sub = $2
        AND expires_at > now() AND copy_tenant_id IS NULL`,
    [input.visitId, input.sub, input.copyTenantId, input.copySessionId],
  );
  if (updated === 1) return "claimed";
  if (updated > 1) throw new DbError("unknown");
  const kept = await q.query<{ id: string }>(
    `SELECT id FROM demo_sessions
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND cognito_sub = $2
        AND expires_at > now() AND copy_tenant_id IS NOT NULL AND copy_deleted_at IS NULL`,
    [input.visitId, input.sub],
  );
  return kept.length === 1 ? "kept" : "refused";
}

// Once the copy is built whole: the visit's copy_ready_at, set once. True when the copy is ready
// after this call (set now, or already); false when the visit no longer points at this copy, or
// the copy was purged.
export async function markCopyReady(
  q: Queryable,
  input: { visitId: string; sub: string; copyTenantId: string },
): Promise<boolean> {
  if (!isUuid(input.visitId) || !isUuid(input.copyTenantId)) return false;
  const updated = await q.execute(
    `UPDATE demo_sessions SET copy_ready_at = now()
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND cognito_sub = $2
        AND copy_tenant_id = CAST($3 AS uuid) AND copy_ready_at IS NULL AND copy_deleted_at IS NULL`,
    [input.visitId, input.sub, input.copyTenantId],
  );
  if (updated === 1) return true;
  if (updated > 1) throw new DbError("unknown");
  const ready = await q.query<{ id: string }>(
    `SELECT id FROM demo_sessions
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND cognito_sub = $2
        AND copy_tenant_id = CAST($3 AS uuid) AND copy_ready_at IS NOT NULL AND copy_deleted_at IS NULL`,
    [input.visitId, input.sub, input.copyTenantId],
  );
  return ready.length === 1;
}

// The copies the purge may delete, oldest first: a visit's copy set and not yet deleted, whose
// visit ended more than graceMinutes ago (the database clock). The partial index
// demo_sessions_copy_purge_idx (0091) serves it.
export type PurgeCandidate = { visitId: string; copyTenantId: string };

export async function purgeCandidates(
  q: Queryable,
  input: { graceMinutes: number; limit: number },
): Promise<PurgeCandidate[]> {
  if (!Number.isSafeInteger(input.graceMinutes) || input.graceMinutes < 0) throw new DbError("unknown");
  if (!Number.isSafeInteger(input.limit) || input.limit < 0) throw new DbError("unknown");
  if (input.limit === 0) return [];
  const rows = await q.query<{ id: unknown; copy_tenant_id: unknown }>(
    `SELECT id, copy_tenant_id FROM demo_sessions
      WHERE tenant_id = current_tenant_id() AND copy_tenant_id IS NOT NULL AND copy_deleted_at IS NULL
        AND expires_at < now() - CAST($1 AS integer) * interval '1 minute'
      ORDER BY expires_at, id
      LIMIT CAST($2 AS integer)`,
    [input.graceMinutes, input.limit],
  );
  return rows.map((r) => {
    if (!isUuid(r.id) || !isUuid(r.copy_tenant_id)) throw new DbError("unknown");
    return { visitId: r.id.toLowerCase(), copyTenantId: r.copy_tenant_id.toLowerCase() };
  });
}

// After the purge deleted the copy: the visit's copy_deleted_at, set once. True when this call set
// it; false when it was already set or the visit no longer points at this copy.
export async function markCopyDeleted(q: Queryable, input: { visitId: string; copyTenantId: string }): Promise<boolean> {
  if (!isUuid(input.visitId) || !isUuid(input.copyTenantId)) return false;
  const updated = await q.execute(
    `UPDATE demo_sessions SET copy_deleted_at = now()
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()
        AND copy_tenant_id = CAST($2 AS uuid) AND copy_deleted_at IS NULL`,
    [input.visitId, input.copyTenantId],
  );
  if (updated > 1) throw new DbError("unknown");
  return updated === 1;
}

// Inside the spend ledger's lock (src/lib/ai/spend.ts reserve): adds the reservation to the
// visit's reserved amount only while the visit is live, the visit stays within its own cap, and
// every visit created today stays within the day's cap. False means nothing was written. The day
// bucket keys on each visit's created_at, as in startVisit: a visit started just before midnight
// UTC stays in the day it started, so what it spends after midnight adds to that day's total (each
// call still within the visit's own cap and the new day's check).
export async function chargeVisit(
  q: Queryable,
  input: { visitId: string; sub: string; nanocents: number; limits: VisitLimits; at: string | null },
): Promise<boolean> {
  const { limits } = input;
  if (!isUuid(input.visitId) || !Number.isSafeInteger(input.nanocents) || input.nanocents < 0) return false;
  const sessionCap = limits.sessionCapCents * NANOCENTS_PER_CENT;
  const dayCap = limits.dayCapCents * NANOCENTS_PER_CENT;
  if (!Number.isSafeInteger(sessionCap) || !Number.isSafeInteger(dayCap)) return false;
  const updated = await q.execute(
    `UPDATE demo_sessions
        SET reserved_nanocents = reserved_nanocents + CAST($3 AS bigint), last_seen_at = ${AT("$6")}
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND cognito_sub = $2
        AND expires_at > ${AT("$6")}
        AND spent_nanocents + reserved_nanocents + CAST($3 AS bigint) <= CAST($4 AS bigint)
        AND (SELECT COALESCE(SUM(d.spent_nanocents + d.reserved_nanocents), 0)
               FROM demo_sessions d
              WHERE d.tenant_id = current_tenant_id() AND d.created_at >= ${DAY_START("$6")})
            + CAST($3 AS bigint) <= CAST($5 AS bigint)`,
    [input.visitId, input.sub, input.nanocents, sessionCap, dayCap, input.at],
  );
  if (updated > 1) throw new DbError("unknown");
  return updated === 1;
}

// Inside a settle (src/lib/ai/spend.ts): the visit's reservation down by what the call's row
// released, its spend up by the call's cost. The visit may have ended since the call started; the
// call still happened, so expiry does not matter here. Anything but one row is unknown, and the
// caller's transaction rolls back with the call left reserved (fail closed).
export async function settleVisit(
  q: Queryable,
  input: { visitId: string; releaseNanocents: number; spentNanocents: number },
): Promise<void> {
  const updated = await q.execute(
    `UPDATE demo_sessions
        SET reserved_nanocents = reserved_nanocents - CAST($2 AS bigint),
            spent_nanocents = spent_nanocents + CAST($3 AS bigint),
            last_seen_at = now()
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()
        AND reserved_nanocents >= CAST($2 AS bigint)`,
    [input.visitId, input.releaseNanocents, input.spentNanocents],
  );
  if (updated !== 1) throw new DbError("unknown");
}

export type TurnGate = "ok" | "visit_ended" | "visit_used";

// Inside the transaction that opens an agent turn (src/lib/agent/gateway/store/turns.ts): counts
// one turn against a live visit under its turnsPerSession limit. A visit that is not live, or not
// this subject's, is ended; one at its limit is used up. Nothing is counted on a refusal.
export async function countVisitTurn(
  q: Queryable,
  input: { visitId: string; sub: string; turnsPerSession: number; at: string },
): Promise<TurnGate> {
  if (!isUuid(input.visitId)) return "visit_ended";
  const updated = await q.execute(
    `UPDATE demo_sessions SET turns = turns + 1, last_seen_at = CAST($4 AS timestamptz)
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND cognito_sub = $2
        AND expires_at > CAST($4 AS timestamptz) AND turns < CAST($3 AS integer)`,
    [input.visitId, input.sub, input.turnsPerSession, input.at],
  );
  if (updated === 1) return "ok";
  if (updated > 1) throw new DbError("unknown");
  const live = await q.query<{ id: string }>(
    `SELECT id FROM demo_sessions
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND cognito_sub = $2
        AND expires_at > CAST($3 AS timestamptz)`,
    [input.visitId, input.sub, input.at],
  );
  return live.length === 1 ? "visit_used" : "visit_ended";
}
