import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { DbError, type Param, type Queryable } from "../db";
import { idempotencyKey, isAttempt, isCanonicalUuid, requestIdOf } from "./keys";
import { assertPendingSubject, readAction, readActionByKey, type PendingSubject } from "./read";
import {
  AMOUNT_LIMIT_CENTS,
  isMoneyFailure,
  KIND_SHAPES,
  MAX_CHECKS,
  MONEY_ACTION_KINDS,
  MoneyError,
  OUTSIDE_SYSTEMS,
  PROPOSERS,
  SUBJECT_STATUSES,
  type Approval,
  type MoneyAction,
  type MoneyActionKind,
  type MoneyChannel,
  type MoneyDraft,
  type MoneyFailure,
  type OutsideSystem,
  type ProposedBy,
  type SubjectTable,
} from "./types";

// The ledger's writes. Every function takes a Queryable already inside a tenant transaction and
// every statement names its tenant (`tenant_id = current_tenant_id()`), so a login that bypasses
// row-level security still writes one tenant. Each write is guarded by the state it expects
// (rows affected 1, or the row moved elsewhere and nothing changes); the table's trigger refuses
// any move the state machine does not allow. Agent code cannot import this file
// (eslint.config.mjs).

// The channel's release switch, read at every call (never cached).
export function switchOn(channel: MoneyChannel): boolean {
  return channel === "payment" ? flags.payoutsEnabled === true : flags.accountingEnabled === true;
}

export type CleanDraft = {
  kind: MoneyActionKind;
  subjectId: string;
  counterpartyId: string;
  amountCents: number;
  attempt: number;
  proposedBy: ProposedBy;
  proposalId: string | null;
  traceId: string | null;
  subjectStatuses: readonly string[] | null;
  batchId: string | null;
};

function invalid(): never {
  throw new MoneyError("validation");
}

function optionalUuid(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return isCanonicalUuid(v) ? v : invalid();
}

// Every field checked whole; anything off is "validation" and nothing is written.
export function validateDraft(draft: MoneyDraft): CleanDraft {
  if (typeof draft !== "object" || draft === null) invalid();
  const kind = draft.kind;
  if (!(MONEY_ACTION_KINDS as readonly unknown[]).includes(kind)) invalid();
  if (!isCanonicalUuid(draft.subjectId) || !isCanonicalUuid(draft.counterpartyId)) invalid();
  const amount = draft.amountCents;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount >= AMOUNT_LIMIT_CENTS) invalid();
  const attempt = draft.attempt ?? 1;
  if (!isAttempt(attempt)) invalid();
  if (!(PROPOSERS as readonly unknown[]).includes(draft.proposedBy)) invalid();
  const table = KIND_SHAPES[kind].subjectTable;
  const allowed: readonly string[] = SUBJECT_STATUSES[table];
  let statuses: readonly string[] | null = null;
  if (allowed.length === 0) {
    if (draft.subjectStatuses !== undefined) invalid();
  } else {
    const given = draft.subjectStatuses;
    if (!Array.isArray(given) || given.length === 0) invalid();
    for (const s of given) if (typeof s !== "string" || !allowed.includes(s)) invalid();
    statuses = [...given];
  }
  return {
    kind,
    subjectId: draft.subjectId,
    counterpartyId: draft.counterpartyId,
    amountCents: amount,
    attempt,
    proposedBy: draft.proposedBy,
    proposalId: optionalUuid(draft.proposalId),
    traceId: optionalUuid(draft.traceId),
    subjectStatuses: statuses,
    batchId: optionalUuid(draft.batchId),
  };
}

// Subject table to the column naming its driver or customer. SQL written here, never input.
const SUBJECT_LOCK_SQL: Readonly<Record<SubjectTable, string>> = {
  advances: lockSql("advances", "driver_id", "status"),
  settlements: lockSql("settlements", "driver_id", "status"),
  invoices: lockSql("invoices", "customer_id", "status"),
  customer_payments: lockSql("customer_payments", "customer_id", null),
};

function lockSql(table: string, counterparty: string, status: string | null): string {
  const col = status ?? "NULL";
  return (
    `SELECT ${col} AS status FROM ${table} WHERE tenant_id = current_tenant_id()` +
    ` AND id = CAST($1 AS uuid) AND ${counterparty} = CAST($2 AS uuid) FOR UPDATE`
  );
}

const INSERT_SQL = `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table,
    subject_id, attempt, idempotency_key, request_id, amount_cents, counterparty_table,
    counterparty_id, proposed_by, proposal_id, trace_id, approver_membership_id, batch_id)
  VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, CAST($5 AS uuid), $6, $7, $8, $9,
    $10, CAST($11 AS uuid), $12, CAST($13 AS uuid), CAST($14 AS uuid), CAST($15 AS uuid),
    CAST($16 AS uuid))
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;

export type ReserveResult = { action: MoneyAction; created: boolean };

function sameRequest(a: MoneyAction, d: CleanDraft): boolean {
  return (
    a.amountCents === d.amountCents &&
    a.counterpartyId === d.counterpartyId &&
    a.kind === d.kind &&
    a.subjectId === d.subjectId &&
    a.attempt === d.attempt
  );
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof DbError && err.sqlState === "23505";
}

// Reserves the ledger row before any outside call. Locks the subject row first (FOR UPDATE, same
// tenant, same driver or customer), so two approvals of one subject run one after the other: the
// second finds the first's row by its key and replays it (created: false) instead of writing
// another. A replay that asks for a different amount or counterparty is refused as duplicate.
// A new row needs the subject in one of the draft's statuses (compared whole) and no earlier
// amount mismatch on the same subject and kind (money may have moved; a person looks first).
// The partial unique index refuses a second live row whatever key a caller builds (23505 ->
// duplicate). `actionId` is injectable for tests only.
export async function reserve(
  q: Queryable,
  approval: Approval,
  draft: MoneyDraft,
  actionId: string = randomUUID(),
): Promise<ReserveResult> {
  const d = validateDraft(draft);
  const shape = KIND_SHAPES[d.kind];
  if (!switchOn(shape.channel)) throw new MoneyError("disabled");
  if (!isCanonicalUuid(approval?.membershipId)) throw new MoneyError("validation");
  if (!isCanonicalUuid(actionId)) throw new MoneyError("validation");

  const subject = await q.query<{ status: unknown }>(SUBJECT_LOCK_SQL[shape.subjectTable], [
    d.subjectId,
    d.counterpartyId,
  ]);
  if (subject.length !== 1) throw new MoneyError("validation");

  const key = idempotencyKey(d.kind, d.subjectId, d.attempt);
  const existing = await readActionByKey(q, key);
  if (existing) {
    if (!sameRequest(existing, d)) throw new MoneyError("duplicate");
    return { action: existing, created: false };
  }

  if (d.subjectStatuses !== null) {
    const status = subject[0].status;
    if (typeof status !== "string" || !d.subjectStatuses.includes(status)) {
      throw new MoneyError("validation");
    }
  }

  const mismatch = await q.query<{ n: unknown }>(
    `SELECT count(*) AS n FROM money_actions WHERE tenant_id = current_tenant_id()
       AND kind = $1 AND subject_id = CAST($2 AS uuid) AND failure_category = 'amount_mismatch'`,
    [d.kind, d.subjectId],
  );
  if (mismatch.length !== 1 || mismatch[0].n !== 0) throw new MoneyError("duplicate");

  let inserted: number;
  try {
    inserted = await q.execute(INSERT_SQL, [
      actionId,
      d.kind,
      shape.channel,
      shape.subjectTable,
      d.subjectId,
      d.attempt,
      key,
      requestIdOf(actionId),
      d.amountCents,
      shape.counterpartyTable,
      d.counterpartyId,
      d.proposedBy,
      d.proposalId,
      d.traceId,
      approval.membershipId,
      d.batchId,
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new MoneyError("duplicate");
    throw err;
  }
  const row = await readActionByKey(q, key);
  if (!row) throw new DbError("unknown");
  if (inserted === 1 && row.id === actionId) return { action: row, created: true };
  if (inserted === 0) {
    if (!sameRequest(row, d)) throw new MoneyError("duplicate");
    return { action: row, created: false };
  }
  throw new DbError("unknown");
}

const BY_ID = "tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)";

function assertId(id: string): void {
  if (!isCanonicalUuid(id)) throw new RangeError("action id is not a lowercase UUID");
}

// reserved -> sent, stamped by the database clock. false: another caller sent it or it is done;
// send nothing.
export async function markSent(q: Queryable, id: string): Promise<boolean> {
  assertId(id);
  const n = await q.execute(
    `UPDATE money_actions SET state = 'sent', sent_at = now() WHERE ${BY_ID} AND state = 'reserved'`,
    [id],
  );
  return n === 1;
}

// What an outside system says it holds for this action.
export type OutsideRecord = {
  system: OutsideSystem;
  type: string;
  id: string;
  ref?: string | null;
  amountCents: number;
};

export function isOutsideRecord(o: unknown): o is OutsideRecord {
  if (typeof o !== "object" || o === null) return false;
  const r = o as Record<string, unknown>;
  const len = (v: unknown, min: number, max: number) =>
    typeof v === "string" && v.length >= min && v.length <= max;
  return (
    (OUTSIDE_SYSTEMS as readonly unknown[]).includes(r.system) &&
    len(r.type, 2, 40) &&
    len(r.id, 1, 120) &&
    (r.ref === undefined || r.ref === null || len(r.ref, 1, 40)) &&
    Number.isSafeInteger(r.amountCents) &&
    (r.amountCents as number) >= 0 &&
    (r.amountCents as number) < AMOUNT_LIMIT_CENTS
  );
}

export type Settlement =
  // The outside system holds exactly the approved amount (a different amount is a failure).
  | { to: "confirmed"; via: "response" | "read_back"; outside: OutsideRecord }
  // A definite no from the outside system, or (read_back, amount_mismatch) the wrong amount.
  | { to: "failed"; via: "response" | "read_back"; category: MoneyFailure; outside?: OutsideRecord }
  // Refused before any call: the switch went off or the adapter is not ready.
  | { to: "failed"; via: "refused"; category: MoneyFailure }
  // Nobody knows (timeout, network, 5xx, a reply without an id): only a read-back settles it.
  | { to: "unknown"; category: MoneyFailure };

const FROM_STATES = {
  response: "state = 'sent'",
  read_back: `state IN ('sent', 'unknown') AND check_count < ${MAX_CHECKS}`,
  refused: "state = 'reserved'",
} as const;

// pastLimit: a person's check on one record's page (reconcile with ignoreCheckLimit) reads that
// record's rows back even at the check limit. It names the subject, and the row must belong to
// it; the count then stays at the limit (the column's own check) instead of rising past it.
function pastLimitGuard(pastLimit: PendingSubject, first: number): { sql: string; params: Param[] } {
  assertPendingSubject(pastLimit);
  return {
    sql: `state IN ('sent', 'unknown') AND subject_table = $${first} AND subject_id = CAST($${first + 1} AS uuid)`,
    params: [pastLimit.table, pastLimit.id],
  };
}

// One guarded UPDATE. true when this call moved the row; false when it had already moved.
// pastLimit applies to a read-back only (see pastLimitGuard).
export async function settle(
  q: Queryable,
  id: string,
  s: Settlement,
  pastLimit?: PendingSubject,
): Promise<boolean> {
  assertId(id);
  if (pastLimit !== undefined && !(s.to !== "unknown" && s.via === "read_back")) {
    throw new RangeError("the check limit is lifted only for a read-back");
  }
  if (s.to === "unknown") {
    if (!isMoneyFailure(s.category)) throw new RangeError("unknown category");
    const n = await q.execute(
      `UPDATE money_actions SET state = 'unknown', failure_category = $2
        WHERE ${BY_ID} AND state = 'sent'`,
      [id, s.category],
    );
    return n === 1;
  }
  const via = s.via;
  if (!(via in FROM_STATES)) throw new RangeError("unknown settle path");
  const outside = "outside" in s ? s.outside : undefined;
  if (s.to === "confirmed" && !isOutsideRecord(outside)) throw new RangeError("no outside record");
  if (s.to === "confirmed" && outside?.amountCents === undefined) throw new RangeError("no amount");
  if (outside !== undefined && !isOutsideRecord(outside)) throw new RangeError("bad outside record");
  const category = s.to === "failed" ? s.category : null;
  if (s.to === "failed" && !isMoneyFailure(category)) throw new RangeError("unknown category");
  const lifted = pastLimit === undefined ? null : pastLimitGuard(pastLimit, 10);
  const checked =
    via !== "read_back"
      ? ""
      : lifted
        ? `, check_count = LEAST(check_count + 1, ${MAX_CHECKS}), last_checked_at = now()`
        : ", check_count = check_count + 1, last_checked_at = now()";
  const n = await q.execute(
    `UPDATE money_actions SET state = $2, settled_via = $3, settled_at = now(),
        failure_category = $4, outside_system = $5, outside_type = $6, outside_id = $7,
        outside_ref = $8, outside_amount_cents = $9${checked}
      WHERE ${BY_ID} AND ${lifted ? lifted.sql : FROM_STATES[via]}`,
    [
      id,
      s.to,
      via,
      category,
      outside?.system ?? null,
      outside?.type ?? null,
      outside?.id ?? null,
      outside?.ref ?? null,
      outside?.amountCents ?? null,
      ...(lifted ? lifted.params : []),
    ],
  );
  return n === 1;
}

// A read-back that found nothing or failed: the row is (or stays) unknown, one more check
// counted. false at the check limit or when the row has settled meanwhile. With pastLimit (see
// pastLimitGuard) a row of that subject at the limit stays unknown and its check time moves on.
export async function bumpCheck(
  q: Queryable,
  id: string,
  category: MoneyFailure,
  pastLimit?: PendingSubject,
): Promise<boolean> {
  assertId(id);
  if (!isMoneyFailure(category)) throw new RangeError("unknown category");
  const lifted = pastLimit === undefined ? null : pastLimitGuard(pastLimit, 3);
  const n = await q.execute(
    lifted
      ? `UPDATE money_actions SET state = 'unknown', failure_category = $2,
            check_count = LEAST(check_count + 1, ${MAX_CHECKS}), last_checked_at = now()
          WHERE ${BY_ID} AND ${lifted.sql}`
      : `UPDATE money_actions SET state = 'unknown', failure_category = $2,
            check_count = check_count + 1, last_checked_at = now()
          WHERE ${BY_ID} AND state IN ('sent', 'unknown') AND check_count < ${MAX_CHECKS}`,
    [id, category, ...(lifted ? lifted.params : [])],
  );
  return n === 1;
}

// The row as stored, or a DbError: an action that cannot be read back is unknown, never absent.
export async function mustReadAction(q: Queryable, id: string): Promise<MoneyAction> {
  const a = await readAction(q, id);
  if (!a) throw new DbError("unknown");
  return a;
}
