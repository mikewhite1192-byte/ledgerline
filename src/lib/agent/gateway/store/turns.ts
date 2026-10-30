import { randomUUID } from "node:crypto";
import { flags } from "../../../../config/flags";
import type { Session } from "../../../auth/claims";
import { countVisitTurn } from "../../../auth/demo-visit";
import { readTenant } from "../../../data/read";
import type { Queryable } from "../../../db";
import type { NoteRow } from "../../../memory/notes";
import { checklistSchema, type Checklist } from "../../checklist";
import type { StepView } from "../../view";
import { readFocus, type FocusSubject, type PageFocus } from "../focus";
import { buildStateSummary } from "./summary";
import type { OpenTurnRefusal, OpenedTurn, StepFinish, StepStart, TurnFinish } from "./types";

// Conversations, turns and steps (migration 0009). Each function runs inside a tenant
// transaction the caller opened with withAgentTenant. Timestamps come from the caller's clock.

// A turn still running after this long was cut off (a lost request); it no longer holds the
// conversation.
export const ABANDONED_AFTER_MS = 120_000;

// The longest state summary and model note a turn keeps (migration 0044's checks).
export const CONTEXT_SUMMARY_MAX = 10_000;
export const REASONING_NOTE_MAX = 2_000;

export type OpenTurnInput = {
  conversationId: string | null;
  turnId: string;
  text: string;
  now: Date;
  summaryChars: number;
  // The carrier notes read for this turn (openAgentTurn reads them for an operator's own question
  // while carrierMemoryEnabled is on); none otherwise.
  notes?: readonly NoteRow[];
  // The record the page the question was asked from is about (the chat's turn route only), as
  // the client sent it: checked here under the tenant before any row is written. Absent or null:
  // no focus, and the turn opens as it always has.
  focus?: PageFocus | null;
};

// Starts a turn: the conversation (new, or this person's own), a refusal while another turn in
// it is running, then the turn row, running, with its state summary.
//
// A demo visit (session.demoSessionId, src/lib/auth/session.ts) sees only its own conversations,
// since every judge shares one login, and each turn it opens counts against the visit's
// turnsPerSession limit (src/lib/auth/demo-visit.ts) after the other checks, so a refused turn
// counts nothing. A visit that ended, or any visit while flags.judgeAccess is off, opens nothing.
// A judge with no visit (the switch went off mid-visit, or a judge token without pc_demo) opens
// nothing either, refused before any row is written; its model calls would be refused anyway
// (src/lib/ai/spend.ts reserve).
//
// A page focus is checked right after the conversation ownership check, so another person's
// conversation is not_found whatever well-formed focus it carries (the route refuses a malformed
// focus by its shape alone, before any read, so that refusal depends on nothing stored), and before
// the first write (the abandoned turn sweep, the visit count, the conversation): with
// agentFocusEnabled off, or for a record that is not a row of this tenant on the ref check's list,
// the turn is refused bad_focus and nothing is written.
export async function openTurn(
  q: Queryable,
  session: Session,
  input: OpenTurnInput,
): Promise<OpenedTurn | { refused: OpenTurnRefusal }> {
  const nowIso = input.now.toISOString();
  const visitId = session.demoSessionId ?? null;
  if (visitId === null) {
    const member = await q.query<{ role: unknown }>(
      "SELECT role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
      [session.sub],
    );
    if (member.some((m) => m.role === "judge")) return { refused: "visit_ended" };
  }
  const taken = await q.query<{ id: string }>("SELECT id FROM turns WHERE id = CAST($1 AS uuid)", [
    input.turnId,
  ]);
  if (taken.length > 0) return { refused: "duplicate" };

  let conversationId = input.conversationId;
  if (conversationId) {
    const own = await q.query<{ id: string }>(
      `SELECT id FROM conversations
        WHERE id = CAST($1 AS uuid) AND created_by = $2
          AND demo_session_id IS NOT DISTINCT FROM CAST($3 AS uuid)`,
      [conversationId, session.sub, visitId],
    );
    if (own.length !== 1) return { refused: "not_found" };
  }

  let focus: FocusSubject | null = null;
  if (input.focus !== undefined && input.focus !== null) {
    if (!flags.agentFocusEnabled) return { refused: "bad_focus" };
    focus = await readFocus(q, input.focus);
    if (focus === null) return { refused: "bad_focus" };
  }

  if (conversationId) {
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
  }
  if (visitId !== null) {
    if (!flags.judgeAccess.enabled) return { refused: "visit_ended" };
    const gate = await countVisitTurn(q, {
      visitId,
      sub: session.sub,
      turnsPerSession: flags.judgeAccess.turnsPerSession,
      at: nowIso,
    });
    if (gate !== "ok") return { refused: gate };
  }
  if (!conversationId) {
    conversationId = randomUUID();
    await q.execute(
      `INSERT INTO conversations (id, tenant_id, created_by, created_at, updated_at, demo_session_id)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS timestamptz),
               CAST($3 AS timestamptz), CAST($4 AS uuid))`,
      [conversationId, session.sub, nowIso, visitId],
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
    focus,
  );
  const next = await q.query<{ seq: number | string }>(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM turns WHERE conversation_id = CAST($1 AS uuid)",
    [conversationId],
  );
  const seq = Number(next[0]?.seq ?? 1);
  const traceId = randomUUID();
  // The summary the model starts from is kept whole on the turn, for the step-through.
  await q.execute(
    `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, summary_chars, status,
                        trace_id, started_at, context_summary, notes_used)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, 'running', $6,
             CAST($7 AS timestamptz), $8, CAST($9 AS jsonb))`,
    [
      input.turnId,
      conversationId,
      seq,
      input.text,
      summary.chars,
      traceId,
      nowIso,
      summary.text.slice(0, CONTEXT_SUMMARY_MAX),
      JSON.stringify(summary.notesUsed),
    ],
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
            detail = detail || CAST($8 AS jsonb),
            reasoning_note = COALESCE($9, reasoning_note)
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
      finish.reasoningNote ? finish.reasoningNote.slice(0, REASONING_NOTE_MAX) : null,
    ],
  );
  if (rows.length !== 1) throw new Error("turn step not finished");
  return stepView(rows[0]);
}

// The turn's checklist, replaced whole while the turn runs. Checked against the stored shape
// first, so a bad list is never written.
export async function setChecklist(q: Queryable, turnId: string, checklist: Checklist): Promise<void> {
  const valid = checklistSchema.parse(checklist);
  const n = await q.execute(
    `UPDATE turns SET checklist = CAST($2 AS jsonb)
      WHERE id = CAST($1 AS uuid) AND status = 'running'`,
    [turnId, JSON.stringify(valid)],
  );
  if (n !== 1) throw new Error("turn checklist not written");
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
            checklist = COALESCE(CAST($10 AS jsonb), checklist),
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
      finish.checklist ? JSON.stringify(checklistSchema.parse(finish.checklist)) : null,
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
