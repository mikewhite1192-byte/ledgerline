import { randomUUID } from "node:crypto";
import { untrustedContentHash } from "../data/content-hash";
import { readTable, readTenant } from "../data/read";
import type { Queryable } from "../db";
import type { NewDocument } from "../documents/store";
import { READ_ATTEMPTS_MAX } from "../documents/types";
import type { PlanRows } from "./plan";

// The policy run's own rows, inside a tenant transaction the caller opened (row-level security
// scopes every statement, and each one also names the tenant). The run writes documents (kind
// pay_policy, never read by the receipt path), untrusted_inputs (the screened transcript), and the
// turn and its steps through the agent's turn store. Nothing here reads or writes a byte of a
// document but readPolicyBytes.

// The fixed text of a run's turn and the fixed label of its first step: the daily count reads
// the label, which only this run writes (the chat loop's labels are tool names).
export const RUN_TEXT_PREFIX = "Set up pay rules from ";
export const OPEN_LABEL = "Store your policy";

export const STAGES = ["open", "read", "screen", "propose", "check"] as const;
export type Stage = (typeof STAGES)[number];

// Runs started by this tenant in the 24 hours before now. The caller holds the tenant's upload
// lock, so two starts at once cannot both pass the count.
export async function countRecentRuns(q: Queryable, nowIso: string): Promise<number> {
  const rows = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM turn_steps
      WHERE tenant_id = current_tenant_id() AND label = $1 AND detail ->> 'stage' = 'open'
        AND started_at > CAST($2 AS timestamptz) - interval '24 hours'`,
    [OPEN_LABEL, nowIso],
  );
  const n = Number(rows[0]?.n);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("could not count policy runs");
  return n;
}

// The receipt insert, with the kind set: a policy row is never offered to the receipt read (its
// Read again takes pending rows of no kind only, store.ts claimStalledRead).
export async function insertPolicyDocument(q: Queryable, d: NewDocument, nowIso: string): Promise<number> {
  return q.execute(
    `INSERT INTO documents
       (id, tenant_id, uploaded_by, filename, mime, byte_length, bytes, content_hash, page_count,
        document_kind, trace_id, created_at, updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, $5, decode($6, 'base64'), $7, $8,
             'pay_policy', CAST($9 AS uuid), CAST($10 AS timestamptz), CAST($10 AS timestamptz))
     ON CONFLICT (tenant_id, content_hash) DO NOTHING`,
    [d.id, d.uploadedBy, d.filename, d.mime, d.byteLength, d.bytesBase64, d.contentHash, d.pageCount, d.traceId, nowIso],
  );
}

export type PolicyDocumentRow = {
  id: string;
  filename: string;
  read_status: "pending" | "read" | "unreadable" | "budget";
  read_attempts: number;
  document_kind: string | null;
  untrusted_input_id: string | null;
};

export async function readPolicyDocument(
  q: Queryable,
  id: string,
  opts: { lock?: boolean } = {},
): Promise<PolicyDocumentRow | null> {
  const rows = await q.query<PolicyDocumentRow>(
    `SELECT id, filename, read_status, read_attempts, document_kind, untrusted_input_id FROM documents
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)${opts.lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, read_attempts: Number(row.read_attempts) };
}

export async function readPolicyBytes(q: Queryable, id: string): Promise<Uint8Array | null> {
  const rows = await q.query<{ base64: string }>(
    `SELECT encode(bytes, 'base64') AS base64 FROM documents
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND document_kind = 'pay_policy'
        AND mime = 'application/pdf'`,
    [id],
  );
  const row = rows[0];
  return row ? new Uint8Array(Buffer.from(row.base64.replace(/\s+/g, ""), "base64")) : null;
}

// One more read started on a policy row still pending or stopped at the spending cap, at most
// READ_ATTEMPTS_MAX in all (the first is the row's default). False: the row is read or
// unreadable, or has no read left.
export async function countReadAttempt(q: Queryable, id: string, nowIso: string): Promise<boolean> {
  const n = await q.execute(
    `UPDATE documents
        SET read_status = 'pending', read_attempts = read_attempts + 1, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND document_kind = 'pay_policy'
        AND read_status IN ('pending', 'budget') AND read_attempts < $2`,
    [id, READ_ATTEMPTS_MAX, nowIso],
  );
  return n === 1;
}

// The read copied the sections: the transcript becomes an outside input (screened before any
// model reads it) and the row is read, with its reading left empty (the transcript is the
// record). Only a pending policy row moves; the return is the transcript id, or null.
export async function finishPolicyRead(
  q: Queryable,
  id: string,
  transcript: string,
  readCallId: string,
  nowIso: string,
): Promise<string | null> {
  const inputId = randomUUID();
  await q.execute(
    `INSERT INTO untrusted_inputs (id, tenant_id, kind, source, body_text, content_hash, received_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'document', 'upload', $2, $3, CAST($4 AS timestamptz))`,
    [inputId, transcript, untrustedContentHash("document", transcript), nowIso],
  );
  const n = await q.execute(
    `UPDATE documents
        SET read_status = 'read', reading = NULL, untrusted_input_id = CAST($2 AS uuid),
            read_call_id = CAST($3 AS uuid), updated_at = CAST($4 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND document_kind = 'pay_policy'
        AND read_status = 'pending'`,
    [id, inputId, readCallId, nowIso],
  );
  if (n !== 1) throw new Error("policy read not finished");
  return inputId;
}

// A definite failure (not a policy, a cut answer, the budget): the row keeps no transcript.
export async function failPolicyRead(
  q: Queryable,
  id: string,
  status: "unreadable" | "budget",
  readCallId: string | null,
  nowIso: string,
): Promise<number> {
  return q.execute(
    `UPDATE documents
        SET read_status = $2, read_call_id = COALESCE(CAST($3 AS uuid), read_call_id),
            updated_at = CAST($4 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND document_kind = 'pay_policy'
        AND read_status = 'pending'`,
    [id, status, readCallId, nowIso],
  );
}

export type TranscriptRow = { id: string; body_text: string; content_hash: string };

export async function readTranscript(q: Queryable, id: string): Promise<TranscriptRow | null> {
  const rows = await q.query<TranscriptRow>(
    `SELECT id, body_text, content_hash FROM untrusted_inputs
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'document'`,
    [id],
  );
  return rows[0] ?? null;
}

export type RunTurnRow = {
  id: string;
  status: "running" | "done" | "partial" | "failed";
  ended_reason: string | null;
  trace_id: string;
  checklist: string | null;
  started_at: string;
};

const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// The person's own run: a turn of theirs whose first step is this run's open step. Null for any
// other turn, so the run routes never touch a chat turn.
export async function readRunTurn(
  q: Queryable,
  sub: string,
  turnId: string,
  opts: { lock?: boolean } = {},
): Promise<RunTurnRow | null> {
  const rows = await q.query<RunTurnRow>(
    `SELECT t.id, t.status, t.ended_reason, t.trace_id, CAST(t.checklist AS text) AS checklist,
            ${utc("t.started_at")} AS started_at
       FROM turns t JOIN conversations c ON c.id = t.conversation_id
      WHERE t.tenant_id = current_tenant_id() AND t.id = CAST($1 AS uuid) AND c.created_by = $2
        AND EXISTS (SELECT 1 FROM turn_steps s WHERE s.turn_id = t.id AND s.seq = 1 AND s.label = $3
                      AND s.detail ->> 'stage' = 'open')${opts.lock ? " FOR UPDATE OF t" : ""}`,
    [turnId, sub, OPEN_LABEL],
  );
  return rows[0] ?? null;
}

export type RunStepRow = {
  id: string;
  seq: number;
  kind: string;
  label: string;
  state: "running" | "done" | "failed";
  stage: string | null;
  detail: string;
  proposal_id: string | null;
  model_call_id: string | null;
  started_at: string;
};

export async function readRunSteps(q: Queryable, turnId: string): Promise<RunStepRow[]> {
  const rows = await q.query<RunStepRow>(
    `SELECT id, seq, kind, label, state, detail ->> 'stage' AS stage, CAST(detail AS text) AS detail,
            proposal_id, model_call_id, ${utc("started_at")} AS started_at
       FROM turn_steps WHERE tenant_id = current_tenant_id() AND turn_id = CAST($1 AS uuid)
      ORDER BY seq`,
    [turnId],
  );
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
}

// A step that never finished (a request cut off): failed, so the stage can be tried again.
export async function failStaleStep(q: Queryable, stepId: string, nowIso: string): Promise<number> {
  return q.execute(
    `UPDATE turn_steps SET state = 'failed', finished_at = CAST($2 AS timestamptz),
            detail = detail || '{"category":"stalled"}'::jsonb
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND state = 'running'`,
    [stepId, nowIso],
  );
}

// What the plan reads: the tenant's time zone, its versions, its pay weeks and their state, and
// its drivers' deduction schedules.
export async function readPlanRows(q: Queryable): Promise<PlanRows> {
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant is set");
  return {
    timezone: tenant.timezone,
    pay_configs: await readTable(q, "pay_configs"),
    settlement_periods: await readTable(q, "settlement_periods"),
    settlements: await readTable(q, "settlements"),
    deduction_schedules: await readTable(q, "deduction_schedules"),
  };
}
