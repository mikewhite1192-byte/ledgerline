import { DbError, type Param, type Queryable } from "../db";
import { isCanonicalUuid } from "./keys";
import {
  isMoneyFailure,
  MAX_CHECKS,
  MONEY_ACTION_KINDS,
  MONEY_ACTION_STATES,
  OUTSIDE_SYSTEMS,
  PROPOSERS,
  type MoneyAction,
  type MoneyActionKind,
  type SubjectTable,
} from "./types";

// Reads of the money ledger, SELECT only, every statement inside a tenant transaction and naming
// its tenant (`tenant_id = current_tenant_id()`), so a login that bypasses row-level security
// still reads one tenant. Safe for agent tools: nothing here writes.

const ts = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`;

export const ACTION_COLUMNS = [
  "CAST(id AS text) AS id",
  "CAST(tenant_id AS text) AS tenant_id",
  "kind",
  "channel",
  "subject_table",
  "CAST(subject_id AS text) AS subject_id",
  "attempt",
  "idempotency_key",
  "request_id",
  "amount_cents",
  "counterparty_table",
  "CAST(counterparty_id AS text) AS counterparty_id",
  "state",
  "failure_category",
  "settled_via",
  "outside_system",
  "outside_type",
  "outside_id",
  "outside_ref",
  "outside_amount_cents",
  "proposed_by",
  "CAST(proposal_id AS text) AS proposal_id",
  "CAST(trace_id AS text) AS trace_id",
  "CAST(approver_membership_id AS text) AS approver_membership_id",
  "CAST(batch_id AS text) AS batch_id",
  "check_count",
  ts("created_at"),
  ts("sent_at"),
  ts("settled_at"),
  ts("last_checked_at"),
  "CAST(floor(EXTRACT(EPOCH FROM (now() - sent_at))) AS integer) AS sent_seconds_ago",
].join(", ");

const FROM = "FROM money_actions WHERE tenant_id = current_tenant_id()";

type ActionRow = Record<string, unknown>;

function fail(): never {
  // A row that does not read back as stored is unknown, never guessed at.
  throw new DbError("unknown");
}

function text(v: unknown): string {
  return typeof v === "string" ? v : fail();
}
function textOrNull(v: unknown): string | null {
  return v === null ? null : text(v);
}
function int(v: unknown): number {
  return Number.isSafeInteger(v) ? (v as number) : fail();
}
function intOrNull(v: unknown): number | null {
  return v === null ? null : int(v);
}
function uuid(v: unknown): string {
  return isCanonicalUuid(v) ? v : fail();
}
function uuidOrNull(v: unknown): string | null {
  return v === null ? null : uuid(v);
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fail();
}
function oneOfOrNull<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return v === null ? null : oneOf(v, allowed);
}

export function actionOf(r: ActionRow): MoneyAction {
  const failure = r.failure_category;
  if (failure !== null && !isMoneyFailure(failure)) fail();
  return {
    id: uuid(r.id),
    tenantId: uuid(r.tenant_id),
    kind: oneOf(r.kind, MONEY_ACTION_KINDS),
    channel: oneOf(r.channel, ["payment", "accounting"] as const),
    subjectTable: oneOf(r.subject_table, [
      "advances",
      "settlements",
      "invoices",
      "customer_payments",
    ] as const),
    subjectId: uuid(r.subject_id),
    attempt: int(r.attempt),
    idempotencyKey: text(r.idempotency_key),
    requestId: text(r.request_id),
    amountCents: int(r.amount_cents),
    counterpartyTable: oneOf(r.counterparty_table, ["drivers", "customers"] as const),
    counterpartyId: uuid(r.counterparty_id),
    state: oneOf(r.state, MONEY_ACTION_STATES),
    failureCategory: failure as MoneyAction["failureCategory"],
    settledVia: oneOfOrNull(r.settled_via, ["response", "read_back", "refused"] as const),
    outsideSystem: oneOfOrNull(r.outside_system, OUTSIDE_SYSTEMS),
    outsideType: textOrNull(r.outside_type),
    outsideId: textOrNull(r.outside_id),
    outsideRef: textOrNull(r.outside_ref),
    outsideAmountCents: intOrNull(r.outside_amount_cents),
    proposedBy: oneOf(r.proposed_by, PROPOSERS),
    proposalId: uuidOrNull(r.proposal_id),
    traceId: uuidOrNull(r.trace_id),
    approverMembershipId: uuid(r.approver_membership_id),
    batchId: uuidOrNull(r.batch_id),
    checkCount: int(r.check_count),
    createdAt: text(r.created_at),
    sentAt: textOrNull(r.sent_at),
    settledAt: textOrNull(r.settled_at),
    lastCheckedAt: textOrNull(r.last_checked_at),
    sentSecondsAgo: intOrNull(r.sent_seconds_ago),
  };
}

async function many(q: Queryable, where: string, params: Param[], tail = ""): Promise<MoneyAction[]> {
  const rows = await q.query<ActionRow>(`SELECT ${ACTION_COLUMNS} ${FROM} AND ${where}${tail}`, params);
  return rows.map(actionOf);
}

async function one(q: Queryable, where: string, params: Param[]): Promise<MoneyAction | null> {
  const rows = await many(q, where, params);
  if (rows.length > 1) fail();
  return rows[0] ?? null;
}

export function readAction(q: Queryable, id: string): Promise<MoneyAction | null> {
  if (!isCanonicalUuid(id)) throw new RangeError("action id is not a lowercase UUID");
  return one(q, "id = CAST($1 AS uuid)", [id]);
}

export function readActionByKey(q: Queryable, key: string): Promise<MoneyAction | null> {
  return one(q, "idempotency_key = $1", [key]);
}

// Every row for one subject, oldest first: the ledger card for an advance, settlement, invoice
// or payment.
export function readBySubject(
  q: Queryable,
  table: SubjectTable,
  subjectId: string,
): Promise<MoneyAction[]> {
  oneOf(table, ["advances", "settlements", "invoices", "customer_payments"] as const);
  if (!isCanonicalUuid(subjectId)) throw new RangeError("subject id is not a lowercase UUID");
  return many(
    q,
    "subject_table = $1 AND subject_id = CAST($2 AS uuid)",
    [table, subjectId],
    " ORDER BY created_at, attempt, id",
  );
}

// Every row of one kind, oldest first: the invoice review reads the latest post of each invoice
// from this in one statement instead of one read per invoice.
export function readByKind(q: Queryable, kind: MoneyActionKind): Promise<MoneyAction[]> {
  oneOf(kind, MONEY_ACTION_KINDS);
  return many(q, "kind = $1", [kind], " ORDER BY created_at, attempt, id");
}

// The card check's reading list: every row sent at or after an instant, in any state, oldest
// first, at most limit of them. The check reads back the confirmed ones, flags the unconfirmed
// ones, and lets a row that has since failed or confirmed close what an earlier check found on
// it. Read only; the check never changes a row.
export function readSentSince(q: Queryable, sinceIso: string, limit: number): Promise<MoneyAction[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit is 1 to 1000");
  return many(
    q,
    "sent_at >= CAST($1 AS timestamptz)",
    [sinceIso],
    ` ORDER BY sent_at, id LIMIT ${limit}`,
  );
}

// One record whose ledger rows a pending read is limited to.
export type PendingSubject = { table: SubjectTable; id: string };
const SUBJECT_TABLES: readonly SubjectTable[] = ["advances", "settlements", "invoices", "customer_payments"];

// A subject checked whole: a known table and a lowercase UUID, or a RangeError.
export function assertPendingSubject(subject: PendingSubject): void {
  if (typeof subject !== "object" || subject === null) throw new RangeError("no subject");
  if (!(SUBJECT_TABLES as readonly unknown[]).includes(subject.table)) {
    throw new RangeError("unknown subject table");
  }
  if (!isCanonicalUuid(subject.id)) throw new RangeError("subject id is not a lowercase UUID");
}

// Every row one approval batch reserved, oldest first (the batch drain and its page).
export function readByBatch(q: Queryable, batchId: string): Promise<MoneyAction[]> {
  if (!isCanonicalUuid(batchId)) throw new RangeError("batch id is not a lowercase UUID");
  return many(q, "batch_id = CAST($1 AS uuid)", [batchId], " ORDER BY created_at, id");
}

// What the reconcile pass works on: rows left unknown, and rows still sent after the window
// (their sender died or its settle failed), of the given kinds only (the ones the caller can
// serve), and of one subject only when the caller names one (a button on one record's page).
// Rows at the check limit need a person and are left out, unless ignoreCheckLimit is true, which
// is accepted only with a subject: a person's check on that one record reads its rows back even
// past the limit (a RangeError without one, so an unscoped read never skips the cap). Rows never
// checked come first, then the least recently checked, so a row that keeps reading back nothing
// rotates behind newer ones instead of holding its place; oldest send first within each. The
// ORDER BY names the table, so it sorts the stored timestamps and id, not the millisecond text
// the SELECT list returns under the same names (two checks in one millisecond would tie).
export function readPending(
  q: Queryable,
  olderThanSeconds: number,
  limit = 5,
  kinds: readonly MoneyActionKind[] = MONEY_ACTION_KINDS,
  subject?: PendingSubject,
  ignoreCheckLimit = false,
): Promise<MoneyAction[]> {
  if (!Number.isSafeInteger(olderThanSeconds) || olderThanSeconds < 0) {
    throw new RangeError("olderThanSeconds must be a whole number of seconds");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("limit must be 1 to 50");
  }
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new RangeError("kinds must name at least one kind");
  }
  for (const k of kinds) {
    if (!(MONEY_ACTION_KINDS as readonly unknown[]).includes(k)) throw new RangeError("unknown kind");
  }
  if (subject !== undefined) assertPendingSubject(subject);
  if (typeof ignoreCheckLimit !== "boolean") throw new RangeError("ignoreCheckLimit must be a boolean");
  if (ignoreCheckLimit && subject === undefined) {
    throw new RangeError("the check limit is lifted only for one named subject");
  }
  const wanted = [...new Set(kinds)];
  // One placeholder per kind; the kinds themselves travel as parameters, and so does the subject.
  const slots = wanted.map((_, i) => `$${i + 3}`).join(", ");
  const next = wanted.length + 3;
  const ofSubject = subject
    ? ` AND subject_table = $${next} AND subject_id = CAST($${next + 1} AS uuid)`
    : "";
  const capped = ignoreCheckLimit ? "" : `check_count < ${MAX_CHECKS} AND `;
  return many(
    q,
    `${capped}(state = 'unknown' OR (state = 'sent'
       AND sent_at < now() - CAST($1 AS integer) * interval '1 second')) AND kind IN (${slots})${ofSubject}`,
    [olderThanSeconds, limit, ...wanted, ...(subject ? [subject.table, subject.id] : [])],
    " ORDER BY money_actions.last_checked_at NULLS FIRST, money_actions.sent_at, money_actions.id" +
      " LIMIT CAST($2 AS integer)",
  );
}

// The tenant's own zone, for dates sent outside (a payout's TxnDate is its local date).
export async function readTenantZone(q: Queryable): Promise<string> {
  const rows = await q.query<{ timezone: unknown }>(
    "SELECT timezone FROM tenants WHERE id = current_tenant_id()",
  );
  if (rows.length !== 1 || typeof rows[0].timezone !== "string" || rows[0].timezone === "") {
    throw new DbError("unknown");
  }
  return rows[0].timezone;
}
