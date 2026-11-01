import type { Queryable } from "../db";

// TMS-MIRROR: the wake-up entry point. A wake-up only says "read this record again"; no payload
// is ever trusted for content. Exactly two fields are read, both bounded: the record type (one of
// three) and the external id (the id pattern the contract allows). Everything else in the payload
// is dropped unread. The dispatch webhook (POST /api/internal/tms-hook/<tenant>) and Settings >
// Demo's "Fire a wake-up twice" keep one tms_wakeups row (0083) per record while it waits; the
// sync takes the rows first on its next pass (takeWakeUps) and reads each record again in full.
// Every query runs inside the caller's tenant transaction (RLS keeps it to that tenant).

export const TMS_RECORD_TYPES = ["load", "driver", "customer"] as const;
export type TmsRecordType = (typeof TMS_RECORD_TYPES)[number];

export type WakeUp = { recordType: TmsRecordType; externalId: string };

const ID = /^[A-Za-z0-9:._-]{1,64}$/;

export function isTmsRecordType(value: unknown): value is TmsRecordType {
  return typeof value === "string" && (TMS_RECORD_TYPES as readonly string[]).includes(value);
}

// The wake-up a payload names, or null when either field is missing or out of bounds.
export function readWakeUp(payload: unknown): WakeUp | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const recordType = p.recordType;
  const externalId = p.externalId;
  if (!isTmsRecordType(recordType)) return null;
  if (typeof externalId !== "string" || !ID.test(externalId)) return null;
  return { recordType, externalId };
}

// Wake-ups one carrier may have waiting. Past it a new one is not kept (the sync's list walk
// still finds the change); the same one again is still the row already there.
export const MAX_WAITING = 500;

// The most times one waiting row counts a repeat (the column's own bound, 0083).
const MAX_SENT = 2_000_000_000;

export type Queued = "new" | "coalesced" | "full";

// One wake-up kept, or coalesced into the row already waiting for the same record. The dedupe
// key is tms_wakeups_one_waiting (tenant_id, record_type, external_id) WHERE processed_at IS NULL:
// the same wake-up sent three times while it waits is one row, its `sent` counting the repeats.
// A repeat moves `sent`, so a sync reading the record while it arrives does not mark it processed
// (markWakeUp matches the count it read), and the record is read again on the next pass.
export async function wakeUpFor(q: Queryable, w: WakeUp, input: { id: string; nowIso: string }): Promise<Queued> {
  const inserted = await q.query<{ id: string }>(
    `INSERT INTO tms_wakeups (id, tenant_id, record_type, external_id, received_at)
     SELECT CAST($1 AS uuid), current_tenant_id(), $2, $3, CAST($4 AS timestamptz)
      WHERE (SELECT count(*) FROM tms_wakeups WHERE tenant_id = current_tenant_id() AND processed_at IS NULL) < $5
     ON CONFLICT (tenant_id, record_type, external_id) WHERE processed_at IS NULL DO NOTHING
     RETURNING CAST(id AS text) AS id`,
    [input.id, w.recordType, w.externalId, input.nowIso, MAX_WAITING],
  );
  if (inserted.length === 1) return "new";
  const repeated = await q.execute(
    `UPDATE tms_wakeups SET sent = LEAST(sent + 1, ${MAX_SENT})
      WHERE tenant_id = current_tenant_id() AND record_type = $1 AND external_id = $2 AND processed_at IS NULL`,
    [w.recordType, w.externalId],
  );
  // None: no room left, or the waiting row was taken in between. Either way the caller may send
  // it again, and the list walk finds the change.
  return repeated === 1 ? "coalesced" : "full";
}

// The first instant of the minute `nowIso` falls in, as the rate bound's row names it.
export function minuteOf(nowIso: string): string {
  const ms = Date.parse(nowIso);
  return new Date(ms - (((ms % 60_000) + 60_000) % 60_000)).toISOString();
}

// The hook's rate bound: true while this call is one of the first `perMinute` the carrier sent
// in this minute. Earlier minutes' rows are removed first. A bound that is not a whole number
// above zero, or a clock that is not a date, takes nothing (fail closed).
export async function takeHookCall(q: Queryable, input: { nowIso: string; perMinute: number }): Promise<boolean> {
  if (!Number.isSafeInteger(input.perMinute) || input.perMinute < 1) return false;
  if (!Number.isFinite(Date.parse(input.nowIso))) return false;
  const minute = minuteOf(input.nowIso);
  await q.execute(
    "DELETE FROM tms_hook_minutes WHERE tenant_id = current_tenant_id() AND minute_at < CAST($1 AS timestamptz)",
    [minute],
  );
  const rows = await q.query<{ accepted: number }>(
    `INSERT INTO tms_hook_minutes (tenant_id, minute_at, accepted) VALUES (current_tenant_id(), CAST($1 AS timestamptz), 1)
     ON CONFLICT (tenant_id, minute_at) DO UPDATE SET accepted = tms_hook_minutes.accepted + 1
      WHERE tms_hook_minutes.accepted < $2
     RETURNING accepted`,
    [minute, input.perMinute],
  );
  return rows.length === 1;
}

export type Accepted = { queued: Queued; withinRate: boolean };

// What the webhook and the demo button both do with one wake-up, in the caller's one transaction:
// keep it (or coalesce it), then count the call against the minute's bound. The wake-up is kept
// either way, so a call over the bound is still read on the next pass; only the wake it would
// start is refused.
export async function acceptWakeUp(
  q: Queryable,
  w: WakeUp,
  input: { id: string; nowIso: string; perMinute: number },
): Promise<Accepted> {
  const queued = await wakeUpFor(q, w, input);
  const withinRate = await takeHookCall(q, input);
  return { queued, withinRate };
}

export type Waiting = WakeUp & { id: string; sent: number };

// The sync's first step: up to `limit` waiting wake-ups, oldest first. Processed rows older than a
// day are removed here too (the caller runs it under the lease).
export async function waitingWakeUps(q: Queryable, input: { nowIso: string; limit: number }): Promise<Waiting[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) return [];
  await q.execute(
    `DELETE FROM tms_wakeups WHERE tenant_id = current_tenant_id() AND processed_at IS NOT NULL
        AND processed_at < CAST($1 AS timestamptz) - interval '1 day'`,
    [input.nowIso],
  );
  const rows = await q.query<{ id: string; record_type: string; external_id: string; sent: number }>(
    `SELECT CAST(id AS text) AS id, record_type, external_id, CAST(sent AS integer) AS sent FROM tms_wakeups
      WHERE tenant_id = current_tenant_id() AND processed_at IS NULL
      ORDER BY received_at, id LIMIT $1`,
    [input.limit],
  );
  const out: Waiting[] = [];
  for (const r of rows) {
    const w = readWakeUp({ recordType: r.record_type, externalId: r.external_id });
    if (w) out.push({ ...w, id: r.id, sent: Number(r.sent) });
  }
  return out;
}

// Marks one wake-up processed, in the transaction that records its read (the load's write, its
// tombstone or its failed attempt). A repeat that arrived since it was read (`sent` moved) keeps
// it waiting. Rows changed: 1, or 0 when it stays.
export function markWakeUp(q: Queryable, w: Waiting, nowIso: string): Promise<number> {
  return q.execute(
    `UPDATE tms_wakeups SET processed_at = CAST($1 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($2 AS uuid) AND sent = $3 AND processed_at IS NULL`,
    [nowIso, w.id, w.sent],
  );
}
