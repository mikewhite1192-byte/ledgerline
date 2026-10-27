import { randomUUID } from "node:crypto";
import type { Session } from "../../../auth/claims";
import { readTenant } from "../../../data/read";
import type { Queryable } from "../../../db";
import type { NoteRow } from "../../../memory/notes";
import type { StepView } from "../../view";
import { buildStateSummary } from "./summary";
import type { OpenTurnRefusal, OpenedTurn, StepFinish, StepStart, TurnFinish } from "./types";

// Conversations, turns and steps (migration 0009). Each function runs inside a tenant
// transaction the caller opened with withAgentTenant. Timestamps come from the caller's clock.

// A turn still running after this long was cut off (a lost request); it no longer holds the
// conversation.
export const ABANDONED_AFTER_MS = 120_000;

export type OpenTurnInput = {
  conversationId: string | null;
  turnId: string;
  text: string;
  now: Date;
  summaryChars: number;
  // The carrier notes read for this turn (openAgentTurn reads them while carrierMemoryEnabled is
  // on); none otherwise.
  notes?: readonly NoteRow[];
};

// Starts a turn: the conversation (new, or this person's own), a refusal while another turn in
// it is running, then the turn row, running, with its state summary.
export async function openTurn(
  q: Queryable,
  session: Session,
  input: OpenTurnInput,
): Promise<OpenedTurn | { refused: OpenTurnRefusal }> {
  const nowIso = input.now.toISOString();
  const taken = await q.query<{ id: string }>("SELECT id FROM turns WHERE id = CAST($1 AS uuid)", [
    input.turnId,
  ]);
  if (taken.length > 0) return { refused: "duplicate" };

  let conversationId = input.conversationId;
  if (conversationId) {
    const own = await q.query<{ id: string }>(
      "SELECT id FROM conversations WHERE id = CAST($1 AS uuid) AND created_by = $2",
      [conversationId, session.sub],
    );
    if (own.length !== 1) return { refused: "not_found" };
    await q.execute(
      `UPDATE turns SET status = 'failed', ended_reason = 'abandoned',
              finished_at = CAST($2 AS timestamptz)
        WHERE conversation_id = CAST($1 AS uuid) AND status = 'running'
          AND started_at < CAST($3 AS timestamptz)`,
      [conversationId, nowIso, new Date(input.now.getTime() - ABANDONED_AFTER_MS).toISOString()],
    );
    const running = await q.query<{ id: string }>(
      "SELECT id FROM turns WHERE conversation_id = CAST($1 AS uuid) AND status = 'running'",
      [conversationId],
    );
    if (running.length > 0) return { refused: "busy" };
  } else {
    conversationId = randomUUID();
    await q.execute(
      `INSERT INTO conversations (id, tenant_id, created_by, created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS timestamptz),
               CAST($3 AS timestamptz))`,
      [conversationId, session.sub, nowIso],
    );
  }

  const tenant = await readTenant(q);
  const summary = await buildStateSummary(
    q,
    session,
    conversationId,
    input.now,
    input.summaryChars,
    input.text,
    input.notes ?? [],
  );
  const next = await q.query<{ seq: number | string }>(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM turns WHERE conversation_id = CAST($1 AS uuid)",
    [conversationId],
  );
  const seq = Number(next[0]?.seq ?? 1);
  const traceId = randomUUID();
  await q.execute(
    `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, summary_chars, status,
                        trace_id, started_at, notes_used)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, 'running', $6,
             CAST($7 AS timestamptz), CAST($8 AS jsonb))`,
    [input.turnId, conversationId, seq, input.text, summary.chars, traceId, nowIso, JSON.stringify(summary.notesUsed)],
  );
  if (input.notes !== undefined) console.info(`memory: ${summary.notesUsed.length} notes for turn ${input.turnId}`);
  await q.execute(
    "UPDATE conversations SET updated_at = CAST($2 AS timestamptz) WHERE id = CAST($1 AS uuid)",
    [conversationId, nowIso],
  );
  return {
    turnId: input.turnId,
    conversationId,
    seq,
    traceId,
    timeZone: tenant?.timezone ?? "UTC",
    summary: summary.text,
    summaryChars: summary.chars,
    summaryCents: summary.cents,
  };
}

type StepRow = { id: string; seq: number | string; kind: string; label: string; state: string };

function stepView(r: StepRow): StepView {
  return {
    id: r.id,
    seq: Number(r.seq),
    kind: r.kind as StepView["kind"],
    label: r.label,
    state: r.state as StepView["state"],
  };
}

export async function startStep(
  q: Queryable,
  turnId: string,
  step: StepStart,
  now: Date,
): Promise<StepView> {
  const id = randomUUID();
  const rows = await q.query<StepRow>(
    `INSERT INTO turn_steps (id, tenant_id, turn_id, seq, kind, label, state, detail, started_at)
     SELECT CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid),
            COALESCE(MAX(seq), 0) + 1, $3, $4, 'running', CAST($5 AS jsonb), CAST($6 AS timestamptz)
       FROM turn_steps WHERE turn_id = CAST($2 AS uuid)
     RETURNING id, seq, kind, label, state`,
    [id, turnId, step.kind, step.label, JSON.stringify(step.detail ?? {}), now.toISOString()],
  );
  if (rows.length !== 1) throw new Error("turn step not written");
  return stepView(rows[0]);
}

export async function finishStep(
  q: Queryable,
  turnId: string,
  stepId: string,
  finish: StepFinish,
  now: Date,
): Promise<StepView> {
  const rows = await q.query<StepRow>(
    `UPDATE turn_steps
        SET state = $3, finished_at = CAST($4 AS timestamptz),
            model_call_id = COALESCE(CAST($5 AS uuid), model_call_id),
            gateway_decision_id = COALESCE(CAST($6 AS uuid), gateway_decision_id),
            proposal_id = COALESCE(CAST($7 AS uuid), proposal_id),
            detail = detail || CAST($8 AS jsonb)
      WHERE id = CAST($1 AS uuid) AND turn_id = CAST($2 AS uuid) AND state = 'running'
      RETURNING id, seq, kind, label, state`,
    [
      stepId,
      turnId,
      finish.state,
      now.toISOString(),
      finish.modelCallId ?? null,
      finish.gatewayDecisionId ?? null,
      finish.proposalId ?? null,
      JSON.stringify(finish.detail ?? {}),
    ],
  );
  if (rows.length !== 1) throw new Error("turn step not finished");
  return stepView(rows[0]);
}

// The cost is the larger of the loop's own sum and the ledger's rows for the trace, which also
// hold the gateway's screening calls.
export async function finishTurn(
  q: Queryable,
  turnId: string,
  finish: TurnFinish,
  now: Date,
): Promise<void> {
  const n = await q.execute(
    `UPDATE turns
        SET status = $2, ended_reason = $3, assistant_text = $4, summary = $5, step_count = $6,
            model_call_count = $7, finished_at = CAST($9 AS timestamptz),
            cost_nanocents = GREATEST($8, COALESCE((SELECT SUM(m.cost_nanocents) FROM model_calls m
                                     WHERE m.trace_id = CAST(turns.trace_id AS uuid)), 0))
      WHERE id = CAST($1 AS uuid) AND status = 'running'`,
    [
      turnId,
      finish.status,
      finish.endedReason,
      finish.text.slice(0, 8000),
      finish.summary.slice(0, 120),
      finish.stepCount,
      finish.modelCallCount,
      finish.costNanocents,
      now.toISOString(),
    ],
  );
  if (n !== 1) throw new Error("turn not finished");
  // A step still running when the turn ends never finished.
  await q.execute(
    `UPDATE turn_steps SET state = 'failed', finished_at = CAST($2 AS timestamptz)
      WHERE turn_id = CAST($1 AS uuid) AND state = 'running'`,
    [turnId, now.toISOString()],
  );
}
