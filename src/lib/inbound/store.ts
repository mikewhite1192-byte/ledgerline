import { DbError, type Queryable } from "../db";
import { isLocalDate } from "../time/local-date";
import { isUuid } from "../uuid";
import type { InboundChannel, InboundDetail, InboundMessage, InboundStatus, ReceiveInput } from "./types";

// Every statement the Inbox runs, inside the caller's tenant transaction. Each names its tenant,
// and every status change is guarded by the status (and, while sorting, the try) it expects, so a
// second press or a slower request changes nothing. Message text is read here and never logged.

export const LIST_LIMIT = 50;

// --- receive ---

// The message text as an untrusted input: kind 'email' and source 'inbound' (0008), whatever the
// channel, so the safety screen and get_inbound_message read it like any other outside message.
export const INSERT_INPUT_SQL =
  "INSERT INTO untrusted_inputs (id, tenant_id, kind, source, driver_id, from_address, subject, body_text," +
  " content_hash, received_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), 'email', 'inbound', CAST($2 AS uuid), $3, $4, $5, $6," +
  " CAST($7 AS timestamptz))";

// No conflict target: a repeated id (this carrier's or, by chance, another's), a repeated Message-ID
// or a repeated input all write nothing, and the caller rolls the input back. RETURNING names the
// row written, so the count is the rows returned, not the driver's affected-row figure.
export const INSERT_MESSAGE_SQL =
  "INSERT INTO inbound_messages (id, tenant_id, channel, input_id, driver_id, from_address, subject, message_id," +
  " received_at, status, created_by, trace_id, created_at, updated_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), $5, $6, $7," +
  " CAST($8 AS timestamptz), 'received', $9, CAST($10 AS uuid), CAST($11 AS timestamptz), CAST($11 AS timestamptz))" +
  " ON CONFLICT DO NOTHING RETURNING CAST(id AS text) AS id";

// The row a repeated event names: its id, or for an email its Message-ID.
export const EXISTING_SQL =
  "SELECT CAST(m.id AS text) AS id FROM inbound_messages m" +
  " WHERE m.tenant_id = current_tenant_id()" +
  " AND (m.id = CAST($1 AS uuid) OR (CAST($2 AS text) IS NOT NULL AND m.message_id = CAST($2 AS text)))" +
  " ORDER BY (m.message_id IS NOT DISTINCT FROM CAST($2 AS text)) DESC, m.id LIMIT 1";

// Counts every message the carrier added today in its own zone, failed and held ones too: each
// one may cost a screen and a sort. Advisory under a race (two pastes in the same instant can both
// pass).
export const MESSAGES_TODAY_SQL =
  "SELECT CAST(count(*) AS integer) AS n FROM inbound_messages m JOIN tenants t ON t.id = m.tenant_id" +
  " WHERE m.tenant_id = current_tenant_id()" +
  " AND CAST(timezone(t.timezone, m.created_at) AS date) =" +
  " CAST(timezone(t.timezone, CAST($1 AS timestamptz)) AS date)";

// The sender's driver: the whole address, compared case-insensitively. Two drivers on one address
// match neither.
export const DRIVER_BY_EMAIL_SQL =
  "SELECT CAST(d.id AS text) AS id FROM drivers d" +
  " WHERE d.tenant_id = current_tenant_id() AND lower(btrim(d.email)) = $1 ORDER BY d.id LIMIT 2";

export async function findExisting(q: Queryable, id: string, messageId: string | null): Promise<string | null> {
  const [row] = await q.query<{ id: string }>(EXISTING_SQL, [id, messageId]);
  return row?.id ?? null;
}

export async function countToday(q: Queryable, nowIso: string): Promise<number> {
  const [row] = await q.query<{ n: number | string }>(MESSAGES_TODAY_SQL, [nowIso]);
  const n = Number(row?.n);
  if (!Number.isSafeInteger(n)) throw new DbError("unknown");
  return n;
}

export async function matchDriver(q: Queryable, address: string | null): Promise<string | null> {
  if (address === null) return null;
  const rows = await q.query<{ id: string }>(DRIVER_BY_EMAIL_SQL, [address]);
  return rows.length === 1 ? rows[0].id : null;
}

export type InsertIds = { inputId: string; driverId: string | null; traceId: string; createdBy: string; nowIso: string };

// Both rows, in the caller's one transaction. Returns the messages written: 0 means the event was
// already here (or the id is taken), and the caller must roll back the input.
export async function insertInbound(
  q: Queryable,
  input: ReceiveInput & { text: string },
  contentHash: string,
  ids: InsertIds,
): Promise<number> {
  await q.execute(INSERT_INPUT_SQL, [
    ids.inputId,
    ids.driverId,
    input.fromAddress,
    input.subject,
    input.text,
    contentHash,
    input.receivedAt.toISOString(),
  ]);
  // Counted from the rows returned, never from an affected-row count, so pg and the Data API
  // answer the same way on a duplicate.
  const written = await q.query<{ id: string }>(INSERT_MESSAGE_SQL, [
    input.id,
    input.channel,
    ids.inputId,
    ids.driverId,
    input.fromAddress,
    input.subject,
    input.messageId,
    input.receivedAt.toISOString(),
    ids.createdBy,
    ids.traceId,
    ids.nowIso,
  ]);
  return written.length;
}

// --- one message for a step ---

export type StepRow = {
  id: string;
  status: InboundStatus;
  attempts: number | string;
  fail_category: string | null;
  input_id: string | null;
  trace_id: string;
  conversation_id: string | null;
  body_text: string | null;
};

export const STEP_SQL =
  "SELECT CAST(m.id AS text) AS id, m.status, m.attempts, m.fail_category, CAST(m.input_id AS text) AS input_id," +
  " CAST(m.trace_id AS text) AS trace_id, CAST(m.conversation_id AS text) AS conversation_id, i.body_text" +
  " FROM inbound_messages m LEFT JOIN untrusted_inputs i ON i.tenant_id = m.tenant_id AND i.id = m.input_id" +
  " WHERE m.tenant_id = current_tenant_id() AND m.id = CAST($1 AS uuid)";

export async function readStep(q: Queryable, id: string): Promise<StepRow | null> {
  const [row] = await q.query<StepRow>(STEP_SQL, [id]);
  return row ?? null;
}

// --- sort ---

// Takes one try: only from received or failed, only while tries are left, and only if nobody took
// one since the row was read ($2). The row reads received while it is being sorted, so a received
// row with a try taken in the last SORT_HOLD_SECONDS is being sorted and a second press is busy;
// after that it is a sort whose outcome was never written, and the next press may take it. The
// hand-off claim uses the same hold.
export const SORT_HOLD_SECONDS = 40;
export const CLAIM_SORT_SQL =
  "UPDATE inbound_messages SET attempts = attempts + 1, status = 'received', fail_category = NULL," +
  " updated_at = CAST($3 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status IN ('received', 'failed')" +
  " AND attempts = $2 AND attempts < $4" +
  ` AND (status = 'failed' OR attempts = 0 OR updated_at <= CAST($3 AS timestamptz) - interval '${SORT_HOLD_SECONDS} seconds')`;

// The newest stored verdict for the text, the one the screen just used (a cached verdict was
// stored for an earlier input with the same text). Error verdicts expire and are never named.
const SCREENING_ID =
  "(SELECT s.id FROM screenings s WHERE s.tenant_id = current_tenant_id() AND s.content_hash = $3" +
  " AND s.screener_version = $4 AND s.expires_at IS NULL ORDER BY s.created_at DESC, s.id DESC LIMIT 1)";

export const SET_BLOCKED_SQL =
  "UPDATE inbound_messages SET status = 'blocked', fail_category = 'screen_flagged'," +
  ` screening_id = ${SCREENING_ID}, updated_at = CAST($5 AS timestamptz)` +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'received' AND attempts = $2";

// $4: 1 gives the try back (a screen error is the screener's, not the message's), 0 keeps it used.
export const SET_FAILED_SQL =
  "UPDATE inbound_messages SET status = 'failed', fail_category = $3, attempts = attempts - $4," +
  " updated_at = CAST($5 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'received' AND attempts = $2";

// driver_id is not written here: it is only ever the driver the sender's address matched, set when
// the message was received. A driver the model names is a guess and is not stored on the row.
export const SET_SORTED_SQL =
  "UPDATE inbound_messages SET status = 'triaged', triage_category = $5, triage_urgency = $6," +
  " triage_amount_cents = $7, triage_dates = CAST($8 AS jsonb), triage_call_id = CAST($9 AS uuid)," +
  ` triage_target = $10, screening_id = ${SCREENING_ID}, updated_at = CAST($11 AS timestamptz)` +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'received' AND attempts = $2";

// --- hand off ---

// Takes the message for one hand-off: a sorted one, or a claim that never named its conversation
// and was taken more than SORT_HOLD_SECONDS ago (its request ended between the claim and the
// link). A newer claim with no conversation is a hand-off in progress, and a second press is busy.
export const CLAIM_HANDOFF_SQL =
  "UPDATE inbound_messages SET status = 'handed_off', updated_at = CAST($2 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND (status = 'triaged'" +
  " OR (status = 'handed_off' AND conversation_id IS NULL" +
  ` AND updated_at <= CAST($2 AS timestamptz) - interval '${SORT_HOLD_SECONDS} seconds'))`;
export const UNCLAIM_HANDOFF_SQL =
  "UPDATE inbound_messages SET status = 'triaged', updated_at = CAST($2 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'handed_off'" +
  " AND conversation_id IS NULL";
// Names the conversation only on a claim that has none yet, so of two turns opened for one
// message (a claim taken again after the hold), only the first to link runs.
export const LINK_SQL =
  "UPDATE inbound_messages SET conversation_id = CAST($2 AS uuid), updated_at = CAST($3 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'handed_off'" +
  " AND conversation_id IS NULL";

// --- reading for the routes ---

type BaseRow = {
  id: string;
  channel: InboundChannel;
  status: InboundStatus;
  fail_category: string | null;
  attempts: number | string;
  received_at: string | Date;
  from_address: string | null;
  subject: string | null;
  driver_id: string | null;
  driver_code: string | null;
  first_name: string | null;
  last_name: string | null;
  triage_category: string | null;
  triage_urgency: string | null;
  triage_amount_cents: number | string | null;
  triage_dates: string | null;
  triage_target: "spark" | "spark_open" | null;
  conversation_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const BASE_COLUMNS =
  "CAST(m.id AS text) AS id, m.channel, m.status, m.fail_category, m.attempts, m.received_at, m.from_address," +
  " m.subject, CAST(m.driver_id AS text) AS driver_id, d.code AS driver_code, d.first_name, d.last_name," +
  " m.triage_category, m.triage_urgency, m.triage_amount_cents, CAST(m.triage_dates AS text) AS triage_dates," +
  " m.triage_target, CAST(m.conversation_id AS text) AS conversation_id, m.created_at, m.updated_at";
const BASE_FROM =
  " FROM inbound_messages m LEFT JOIN drivers d ON d.tenant_id = m.tenant_id AND d.id = m.driver_id";

function whole(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new DbError("unknown");
  return n;
}

function iso(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new DbError("unknown");
  return d.toISOString();
}

function datesOf(raw: string | null): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((d): d is string => isLocalDate(d)) : [];
}

function base(r: BaseRow): InboundMessage {
  return {
    id: r.id,
    channel: r.channel,
    status: r.status,
    failCategory: r.fail_category,
    attempts: whole(r.attempts) ?? 0,
    receivedAt: iso(r.received_at),
    fromAddress: r.from_address,
    subject: r.subject,
    driverId: r.driver_id,
    driverCode: r.driver_code,
    driverName: r.first_name !== null && r.last_name !== null ? `${r.first_name} ${r.last_name}` : null,
    category: r.triage_category,
    urgency: r.triage_urgency,
    amountCents: whole(r.triage_amount_cents),
    dates: datesOf(r.triage_dates),
    triageTarget: r.triage_target,
    conversationId: r.conversation_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

// Newest first.
export async function listInbound(q: Queryable, limit = LIST_LIMIT): Promise<InboundMessage[]> {
  const n = Math.max(1, Math.min(LIST_LIMIT, Math.floor(limit)));
  const rows = await q.query<BaseRow>(
    `SELECT ${BASE_COLUMNS}${BASE_FROM} WHERE m.tenant_id = current_tenant_id()` +
      ` ORDER BY m.received_at DESC, m.id DESC LIMIT ${n}`,
  );
  return rows.map(base);
}

export async function readInbound(q: Queryable, id: string): Promise<InboundMessage | null> {
  if (!isUuid(id)) return null;
  const [r] = await q.query<BaseRow>(
    `SELECT ${BASE_COLUMNS}${BASE_FROM} WHERE m.tenant_id = current_tenant_id() AND m.id = CAST($1 AS uuid)`,
    [id.toLowerCase()],
  );
  return r ? base(r) : null;
}

export async function readInboundDetail(q: Queryable, id: string): Promise<InboundDetail | null> {
  if (!isUuid(id)) return null;
  const [r] = await q.query<BaseRow & { trace_id: string; body_text: string | null }>(
    `SELECT ${BASE_COLUMNS}, CAST(m.trace_id AS text) AS trace_id, i.body_text${BASE_FROM}` +
      " LEFT JOIN untrusted_inputs i ON i.tenant_id = m.tenant_id AND i.id = m.input_id" +
      " WHERE m.tenant_id = current_tenant_id() AND m.id = CAST($1 AS uuid)",
    [id.toLowerCase()],
  );
  if (!r) return null;
  const calls = await q.query<{
    target: string;
    purpose: string;
    status: string;
    duration_ms: number | string | null;
    cost_nanocents: number | string;
  }>(
    "SELECT target, purpose, status, duration_ms, cost_nanocents FROM model_calls" +
      " WHERE tenant_id = current_tenant_id() AND trace_id = CAST($1 AS uuid)" +
      " ORDER BY created_at, id LIMIT 50",
    [r.trace_id],
  );
  return {
    ...base(r),
    text: r.body_text,
    traceId: r.trace_id,
    trace: calls.map((c) => ({
      target: c.target,
      purpose: c.purpose,
      status: c.status,
      durationMs: whole(c.duration_ms),
      costNanocents: whole(c.cost_nanocents) ?? 0,
    })),
  };
}
