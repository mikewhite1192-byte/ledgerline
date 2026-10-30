import { createHash, randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { runAudit, type AuditResult } from "../agent/auditor/run";
import { checklistSchema, type Checklist, type ChecklistState } from "../agent/checklist";
import { screenUntrustedInput, type ScreenOutcome } from "../agent/gateway/screen";
import { finishStep, finishTurn, openTurn, setChecklist, startStep } from "../agent/gateway/store/turns";
import { withAgentTenant } from "../agent/gateway/tenant";
import type { GatewayContext } from "../agent/gateway/types";
import { AiError, complete, type AiDeps, type AiRequest, type AiResult } from "../ai";
import { looksLike, pdfPages } from "../ai/providers/media";
import type { Session } from "../auth/claims";
import { sortVersions } from "../data/config-version";
import { readTenant } from "../data/read";
import { getDb, type Queryable, type TenantDb } from "../db";
import { safeFilename } from "../documents/service";
import { findDocumentByHash, lockTenantUploads } from "../documents/store";
import { persistEngineProposal } from "../proposals/engine";
import { ConfigError } from "../rules-engine";
import { parsePolicyArgs, stateCounts } from "./args";
import { proposeRequest, readRequest } from "./format";
import { mapAnswer, parseRulesAnswer, type RulesAnswer } from "./map";
import { chooseStart, escrowOnSchedules, planVersion } from "./plan";
import { sectionsFromAnswer, sectionsOfTranscript, transcriptOf } from "./sections";
import {
  countReadAttempt,
  countRecentRuns,
  failPolicyRead,
  failStaleStep,
  finishPolicyRead,
  insertPolicyDocument,
  OPEN_LABEL,
  readPlanRows,
  readPolicyBytes,
  readPolicyDocument,
  readRunSteps,
  readRunTurn,
  readTranscript,
  RUN_TEXT_PREFIX,
  STAGES,
  type RunStepRow,
  type RunTurnRow,
  type Stage,
} from "./store";
import { CHECKLIST_ITEMS, checklistOf, END_WORDS, STEP_LABELS, type ChecklistKey, type EndReason } from "./words";

// A policy run, one stage per request: start stores the file and opens the turn with its
// checklist; each advance runs the next stage (read, screen, propose, check) and the page polls
// until the turn ends. A stage takes the turn's row lock, starts its step and commits; the model
// call runs outside any transaction; a second transaction finishes the step (only while it is
// still running) and writes what the stage made. A step left running past STEP_LEASE_MS (a cut
// request) is failed and the stage tried again, at most STAGE_ATTEMPTS times. The run reads and
// proposes only: its one write that matters is a pay_policy_setup card, and nothing changes until
// a person approves it (the executor checks everything again).

export const STEP_LEASE_MS = 60_000;
export const STAGE_ATTEMPTS = 2;
const SCREEN_DEADLINE_MS = 25_000;

const BUDGET: readonly string[] = ["cap", "too_expensive", "billing", "job_cap"];
const LOST: ReadonlySet<string> = new Set(["turn step not finished", "policy read not finished"]);

export type RunComplete = (target: "spark", request: AiRequest, session: Session) => Promise<AiResult>;

export type RunDeps = {
  db?: TenantDb;
  now?: () => Date;
  complete?: RunComplete;
  ai?: AiDeps;
  screen?: (ctx: GatewayContext, inputId: string) => Promise<ScreenOutcome>;
  audit?: (session: Session, proposalId: string) => Promise<AuditResult>;
};

export type PolicyFile = { name: string; type: string; bytes: Uint8Array };

export type StartRefusal =
  | "disabled"
  | "too_large"
  | "unsupported"
  | "too_many_pages"
  | "limit"
  | "used_elsewhere"
  | "busy";

export type StartOutcome = { ok: true; turnId: string; documentId: string } | { ok: false; error: StartRefusal };

export type RunStepView = { seq: number; kind: string; label: string; state: string; stage: string | null };

export type RunView = {
  turnId: string;
  status: RunTurnRow["status"];
  endedReason: string | null;
  checklist: Checklist | null;
  steps: RunStepView[];
  documentId: string | null;
  proposalId: string | null;
};

export type AdvanceOutcome = { ok: true; view: RunView; busy: boolean } | { ok: false; error: "disabled" | "not_found" };

// A PDF only, under the policy limits. A PDF whose pages cannot be counted reads as the worst
// case and is refused.
export function checkPolicyFile(
  file: PolicyFile,
): { ok: true; pageCount: number } | { ok: false; error: "too_large" | "unsupported" | "too_many_pages" } {
  const limits = flags.policyLimits;
  if (file.bytes.byteLength > limits.maxBytes) return { ok: false, error: "too_large" };
  if (file.bytes.byteLength === 0 || file.type !== "application/pdf") return { ok: false, error: "unsupported" };
  if (!looksLike("application/pdf", file.bytes)) return { ok: false, error: "unsupported" };
  const pages = pdfPages(file.bytes);
  if (pages < 1) return { ok: false, error: "unsupported" };
  if (pages > limits.maxPdfPages) return { ok: false, error: "too_many_pages" };
  return { ok: true, pageCount: pages };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base64Of = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

function clockOf(deps: RunDeps): () => Date {
  return deps.now ?? (() => new Date());
}

// Stores the file (the same file again is the same row) and opens the run's turn: its open step,
// done, and the checklist. One transaction under the tenant's upload lock, so the daily count
// holds when two starts race.
export async function startPolicyRun(session: Session, file: PolicyFile, deps: RunDeps = {}): Promise<StartOutcome> {
  if (!flags.policyOnboardEnabled) return { ok: false, error: "disabled" };
  const checked = checkPolicyFile(file);
  if (!checked.ok) return checked;
  const db = deps.db ?? getDb();
  const now = clockOf(deps)();
  const nowIso = now.toISOString();
  const contentHash = sha256(file.bytes);
  const filename = safeFilename(file.name);
  const turnId = randomUUID();
  return withAgentTenant(db, session, async (q): Promise<StartOutcome> => {
    await lockTenantUploads(q);
    if ((await countRecentRuns(q, nowIso)) >= flags.policyLimits.perTenantPerDay) return { ok: false, error: "limit" };
    let existing = await findDocumentByHash(q, contentHash);
    let documentId: string;
    if (existing) {
      if (existing.document_kind !== "pay_policy") return { ok: false, error: "used_elsewhere" };
      documentId = existing.id;
    } else {
      documentId = randomUUID();
      const inserted = await insertPolicyDocument(
        q,
        {
          id: documentId,
          uploadedBy: session.sub,
          filename,
          mime: "application/pdf",
          byteLength: file.bytes.byteLength,
          bytesBase64: base64Of(file.bytes),
          contentHash,
          pageCount: checked.pageCount,
          traceId: randomUUID(),
        },
        nowIso,
      );
      if (inserted !== 1) {
        existing = await findDocumentByHash(q, contentHash);
        if (!existing) throw new Error("policy document insert took no row");
        if (existing.document_kind !== "pay_policy") return { ok: false, error: "used_elsewhere" };
        documentId = existing.id;
      }
    }
    const opened = await openTurn(q, session, {
      conversationId: null,
      turnId,
      text: `${RUN_TEXT_PREFIX}${filename}`,
      now,
      summaryChars: flags.agentTurnLimits.summaryChars,
    });
    if ("refused" in opened) return { ok: false, error: "busy" };
    const step = await startStep(
      q,
      turnId,
      { kind: "tool", label: OPEN_LABEL, detail: { stage: "open", documentId, reused: existing !== null } },
      now,
    );
    await finishStep(q, turnId, step.id, { state: "done" }, now);
    await setChecklist(q, turnId, checklistOf({}));
    return { ok: true, turnId, documentId };
  });
}

function parseDetail(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idOf = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);

type Facts = { documentId: string | null; reusedDocument: boolean; inputId: string | null; proposalId: string | null };

function factsOf(steps: readonly RunStepRow[]): Facts {
  const facts: Facts = { documentId: null, reusedDocument: false, inputId: null, proposalId: null };
  for (const s of steps) {
    if (s.state !== "done") continue;
    const d = parseDetail(s.detail);
    if (s.stage === "open") {
      facts.documentId = idOf(d.documentId);
      facts.reusedDocument = d.reused === true;
    }
    if (s.stage === "read") facts.inputId = idOf(d.inputId);
    if (s.stage === "propose") facts.proposalId = idOf(s.proposal_id);
  }
  return facts;
}

function nextStage(steps: readonly RunStepRow[]): Exclude<Stage, "open"> | null {
  for (const stage of STAGES) {
    if (stage === "open") continue;
    if (!steps.some((s) => s.stage === stage && s.state === "done")) return stage;
  }
  return null;
}

type States = Partial<Record<ChecklistKey, ChecklistState>>;

function statesOf(text: string | null): States {
  const states: States = {};
  if (text === null) return states;
  const parsed = checklistSchema.safeParse(parseDetail(text));
  if (!parsed.success) return states;
  for (const item of parsed.data.items) {
    if (CHECKLIST_ITEMS.some((i) => i.key === item.key)) states[item.key as ChecklistKey] = item.state;
  }
  return states;
}

type Run = { turnId: string; traceId: string; states: States; steps: RunStepRow[]; facts: Facts };

async function endRun(q: Queryable, run: Run, reason: EndReason, now: Date): Promise<void> {
  const status = reason === "card_ready" ? "done" : "failed";
  const states: States = { ...run.states };
  for (const item of CHECKLIST_ITEMS) {
    if (states[item.key] === "doing") states[item.key] = status === "done" ? "done" : "not_done";
  }
  const steps = await readRunSteps(q, run.turnId);
  await finishTurn(
    q,
    run.turnId,
    {
      status,
      endedReason: reason,
      text: END_WORDS[reason],
      summary: END_WORDS[reason].slice(0, 120),
      stepCount: steps.length,
      modelCallCount: steps.filter((s) => s.model_call_id !== null).length,
      // finishTurn adds up the model_calls on the turn's trace (the read, the screen and the
      // propose call each carry it), so the turn's cost is what its calls cost.
      costNanocents: 0,
      checklist: checklistOf(states),
    },
    now,
  );
}

async function mark(q: Queryable, run: Run, states: States): Promise<void> {
  run.states = { ...run.states, ...states };
  await setChecklist(q, run.turnId, checklistOf(run.states));
}

function viewOf(turn: RunTurnRow, steps: readonly RunStepRow[]): RunView {
  const facts = factsOf(steps);
  const parsed = turn.checklist === null ? null : checklistSchema.safeParse(parseDetail(turn.checklist));
  return {
    turnId: turn.id,
    status: turn.status,
    endedReason: turn.ended_reason,
    checklist: parsed && parsed.success ? parsed.data : null,
    steps: steps.map((s) => ({ seq: s.seq, kind: s.kind, label: s.label, state: s.state, stage: s.stage })),
    documentId: facts.documentId,
    proposalId: facts.proposalId,
  };
}

export async function readPolicyRun(session: Session, turnId: string, deps: RunDeps = {}): Promise<RunView | null> {
  if (!UUID.test(turnId)) return null;
  return withAgentTenant(deps.db ?? getDb(), session, async (q) => {
    const turn = await readRunTurn(q, session.sub, turnId);
    return turn ? viewOf(turn, await readRunSteps(q, turnId)) : null;
  });
}

// What a stage's first transaction hands to its work: the step it started and the stage's inputs.
type Begun =
  | { kind: "read"; stepId: string; bytes: Uint8Array; documentId: string }
  | { kind: "screen"; stepId: string; inputId: string }
  | { kind: "propose"; stepId: string; inputId: string; body: string; sections: Map<string, string> }
  | { kind: "check"; stepId: string; proposalId: string };

type Prep = { kind: "not_found" } | { kind: "view" } | { kind: "busy" } | { kind: "work"; run: Run; begun: Begun };

async function prepare(q: Queryable, session: Session, turnId: string, now: Date): Promise<Prep> {
  const nowIso = now.toISOString();
  const turn = await readRunTurn(q, session.sub, turnId, { lock: true });
  if (!turn) return { kind: "not_found" };
  if (turn.status !== "running") return { kind: "view" };
  let steps = await readRunSteps(q, turnId);
  const running = steps.find((s) => s.state === "running");
  if (running) {
    if (now.getTime() - Date.parse(running.started_at) < STEP_LEASE_MS) return { kind: "busy" };
    await failStaleStep(q, running.id, nowIso);
    steps = await readRunSteps(q, turnId);
  }
  const run: Run = { turnId, traceId: turn.trace_id, states: statesOf(turn.checklist), steps, facts: factsOf(steps) };
  const stage = nextStage(steps);
  if (stage === null) {
    await endRun(q, run, "card_ready", now);
    return { kind: "view" };
  }
  if (steps.filter((s) => s.stage === stage && s.state === "failed").length >= STAGE_ATTEMPTS) {
    // The card stands even when the second check could not finish.
    await endRun(q, run, stage === "check" ? "card_ready" : "stalled", now);
    return { kind: "view" };
  }
  const start = async (kind: "model" | "screen" | "proposal" | "tool", detail: Record<string, unknown>) =>
    (await startStep(q, turnId, { kind, label: STEP_LABELS[stage], detail: { stage, ...detail } }, now)).id;

  if (stage === "read") {
    const documentId = run.facts.documentId;
    const doc = documentId ? await readPolicyDocument(q, documentId, { lock: true }) : null;
    if (!documentId || !doc || doc.document_kind !== "pay_policy") {
      await endRun(q, run, "error", now);
      return { kind: "view" };
    }
    if (doc.read_status === "read" && doc.untrusted_input_id !== null) {
      // Read before (the same file in an earlier run): the stored transcript, no second call.
      const stepId = await start("model", { documentId });
      await finishStep(q, turnId, stepId, { state: "done", detail: { inputId: doc.untrusted_input_id, reused: true } }, now);
      await mark(q, run, { read: "done" });
      return { kind: "view" };
    }
    if (doc.read_status === "unreadable" || doc.read_status === "read") {
      await endRun(q, run, "unreadable", now);
      return { kind: "view" };
    }
    // The row's first read is counted when it is stored; every other one is counted here.
    const first = !run.facts.reusedDocument && !steps.some((s) => s.stage === "read");
    if (!first && !(await countReadAttempt(q, documentId, nowIso))) {
      await endRun(q, run, "attempt_limit", now);
      return { kind: "view" };
    }
    const bytes = await readPolicyBytes(q, documentId);
    if (!bytes) {
      await endRun(q, run, "error", now);
      return { kind: "view" };
    }
    const stepId = await start("model", { documentId });
    await mark(q, run, { read: "doing" });
    return { kind: "work", run, begun: { kind: "read", stepId, bytes, documentId } };
  }

  const inputId = run.facts.inputId;
  if (!inputId) {
    await endRun(q, run, "error", now);
    return { kind: "view" };
  }
  if (stage === "screen") {
    const stepId = await start("screen", { inputId });
    await mark(q, run, { screen: "doing" });
    return { kind: "work", run, begun: { kind: "screen", stepId, inputId } };
  }
  if (stage === "propose") {
    const transcript = await readTranscript(q, inputId);
    const sections = transcript ? sectionsOfTranscript(transcript.body_text) : null;
    if (!transcript || !sections) {
      await endRun(q, run, "error", now);
      return { kind: "view" };
    }
    const stepId = await start("proposal", { inputId });
    await mark(q, run, { map: "doing" });
    return { kind: "work", run, begun: { kind: "propose", stepId, inputId, body: transcript.body_text, sections } };
  }
  const proposalId = run.facts.proposalId;
  if (!proposalId) {
    await endRun(q, run, "error", now);
    return { kind: "view" };
  }
  const stepId = await start("tool", { proposalId });
  await mark(q, run, { card: "doing" });
  return { kind: "work", run, begun: { kind: "check", stepId, proposalId } };
}

type CallOutcome =
  | { ok: true; result: AiResult }
  | { ok: false; status: "budget" | "retry" | "failed"; category: string; callId: string | null };

async function callModel(call: RunComplete, request: AiRequest, session: Session, where: string): Promise<CallOutcome> {
  // The switch is read again here, at the outside call, whatever the route already checked.
  if (!flags.policyOnboardEnabled) return { ok: false, status: "failed", category: "disabled", callId: null };
  try {
    const result = await call("spark", request, session);
    if (result.status !== "ok") {
      console.error(`policy: ${where} failed category=incomplete`);
      return { ok: false, status: "failed", category: "incomplete", callId: result.callId };
    }
    return { ok: true, result };
  } catch (err) {
    if (err instanceof AiError) {
      console.error(`policy: ${where} failed category=${err.category}`);
      if (BUDGET.includes(err.category)) return { ok: false, status: "budget", category: "budget", callId: null };
      return { ok: false, status: "retry", category: "model_error", callId: null };
    }
    console.error(`policy: ${where} failed error=${(err as Error)?.name ?? "unknown"}`);
    return { ok: false, status: "retry", category: "error", callId: null };
  }
}

type Work =
  | { kind: "read"; outcome: CallOutcome; sections: ReturnType<typeof sectionsFromAnswer> }
  | { kind: "screen"; outcome: ScreenOutcome | null }
  | { kind: "propose"; outcome: CallOutcome; answer: RulesAnswer | null }
  | { kind: "check"; result: AuditResult | null };

async function work(begun: Begun, run: Run, session: Session, now: Date, deps: RunDeps): Promise<Work> {
  const call: RunComplete = deps.complete ?? ((t, r, s) => complete(t, r, s, deps.ai ?? {}));
  if (begun.kind === "read") {
    const outcome = await callModel(call, readRequest(begun.bytes, run.traceId), session, "read");
    return { kind: "read", outcome, sections: outcome.ok ? sectionsFromAnswer(outcome.result.text) : null };
  }
  if (begun.kind === "screen") {
    const screen =
      deps.screen ?? ((ctx: GatewayContext, id: string) => screenUntrustedInput(ctx, id, { db: deps.db }));
    try {
      const outcome = await screen(
        {
          session,
          role: "operator",
          model: "spark_open",
          turnId: run.turnId,
          traceId: run.traceId,
          now,
          deadlineAt: now.getTime() + SCREEN_DEADLINE_MS,
          timeZone: "UTC",
        },
        begun.inputId,
      );
      return { kind: "screen", outcome };
    } catch (err) {
      console.error(`policy: screen failed error=${(err as Error)?.name ?? "unknown"}`);
      return { kind: "screen", outcome: null };
    }
  }
  if (begun.kind === "propose") {
    const outcome = await callModel(call, proposeRequest(begun.body, run.traceId), session, "propose");
    return { kind: "propose", outcome, answer: outcome.ok ? parseRulesAnswer(outcome.result.text) : null };
  }
  const audit = deps.audit ?? ((s: Session, id: string) => runAudit(s, id, { db: deps.db }));
  try {
    return { kind: "check", result: await audit(session, begun.proposalId) };
  } catch (err) {
    console.error(`policy: second check failed error=${(err as Error)?.name ?? "unknown"}`);
    return { kind: "check", result: null };
  }
}

// The step failed; the stage may be tried again (the turn goes on).
async function failStep(q: Queryable, run: Run, stepId: string, category: string, callId: string | null, now: Date) {
  await finishStep(q, run.turnId, stepId, { state: "failed", modelCallId: callId, detail: { category } }, now);
}

async function finish(q: Queryable, session: Session, run: Run, begun: Begun, done: Work, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  if (begun.kind === "read" && done.kind === "read") {
    const o = done.outcome;
    if (!o.ok) {
      await failStep(q, run, begun.stepId, o.category, o.callId, now);
      if (o.status === "retry") return;
      await failPolicyRead(q, begun.documentId, o.status === "budget" ? "budget" : "unreadable", o.callId, nowIso);
      await endRun(q, run, o.status === "budget" ? "budget" : "unreadable", now);
      return;
    }
    if (!done.sections) {
      await failStep(q, run, begun.stepId, "schema", o.result.callId, now);
      await failPolicyRead(q, begun.documentId, "unreadable", o.result.callId, nowIso);
      await endRun(q, run, "unreadable", now);
      return;
    }
    // One transaction: a step that was failed meanwhile throws and takes the transcript with it.
    const inputId = await finishPolicyRead(q, begun.documentId, transcriptOf(done.sections), o.result.callId, nowIso);
    await finishStep(
      q,
      run.turnId,
      begun.stepId,
      { state: "done", modelCallId: o.result.callId, detail: { sections: done.sections.length, inputId } },
      now,
    );
    await mark(q, run, { read: "done" });
    return;
  }

  if (begun.kind === "screen" && done.kind === "screen") {
    const o = done.outcome;
    if (!o || o.verdict.via === "error") {
      const budget = o?.reason === "budget";
      await finishStep(
        q,
        run.turnId,
        begun.stepId,
        { state: "failed", gatewayDecisionId: o?.decisionId ?? null, detail: { category: budget ? "budget" : "screen_error" } },
        now,
      );
      if (budget) await endRun(q, run, "budget", now);
      return;
    }
    if (o.verdict.verdict !== "clean") {
      await finishStep(
        q,
        run.turnId,
        begun.stepId,
        { state: "failed", gatewayDecisionId: o.decisionId, detail: { category: "flagged" } },
        now,
      );
      await endRun(q, run, "flagged", now);
      return;
    }
    await finishStep(
      q,
      run.turnId,
      begun.stepId,
      { state: "done", gatewayDecisionId: o.decisionId, detail: { verdict: "clean" } },
      now,
    );
    await mark(q, run, { screen: "done" });
    return;
  }

  if (begun.kind === "propose" && done.kind === "propose") {
    const o = done.outcome;
    if (!o.ok) {
      await failStep(q, run, begun.stepId, o.category, o.callId, now);
      if (o.status === "budget") await endRun(q, run, "budget", now);
      return;
    }
    const callId = o.result.callId;
    if (!done.answer) {
      await failStep(q, run, begun.stepId, "schema", callId, now);
      return;
    }
    const end = async (reason: EndReason, category: string) => {
      await failStep(q, run, begun.stepId, category, callId, now);
      await endRun(q, run, reason, now);
    };
    const rows = await readPlanRows(q);
    let newest;
    try {
      const versions = sortVersions(rows.pay_configs);
      newest = versions[versions.length - 1];
    } catch (error) {
      if (error instanceof ConfigError) return end("no_pay_config", "no_pay_config");
      throw error;
    }
    // The document's own date is read first (against the newest version), then the start is
    // chosen and the rules mapped again against the version in force before it.
    const first = mapAnswer(begun.sections, begun.body, done.answer, newest);
    const placement = chooseStart(rows, first.documentDate, now);
    if (!placement.ok) return end(placement.reason === "no_pay_config" ? "no_pay_config" : "cannot_start", placement.reason);
    const mapped = mapAnswer(begun.sections, begun.body, done.answer, placement.base);
    const counts = stateCounts(mapped.fields);
    if (counts.found + counts.needsYou === 0) return end("nothing_found", "nothing_found");
    const exceptions = new Set(mapped.exceptions);
    if (counts.needsYou === 0) {
      const plan = planVersion(placement.base, mapped.fields, {});
      if (!plan.ok && plan.reason === "no_change") return end("no_change", "no_change");
      if (plan.ok && plan.adminRequired) exceptions.add("admin_required");
    }
    if (placement.moved) exceptions.add("date_moved");
    const escrowStated =
      mapped.fields.escrow_per_settlement_cents.state !== "not_in_document" ||
      mapped.fields.escrow_target_cents.state !== "not_in_document";
    if (escrowStated && escrowOnSchedules(rows, placement.effectiveFrom)) exceptions.add("escrow_on_driver_schedules");
    const tenant = await readTenant(q);
    if (mapped.carrierName !== null && tenant && mapped.carrierName !== tenant.name) {
      exceptions.add("carrier_name_differs");
    }
    const documentId = run.facts.documentId;
    const args = parsePolicyArgs({
      v: 1,
      documentId,
      transcriptId: begun.inputId,
      baseVersionId: placement.base.id,
      effectiveFrom: placement.effectiveFrom,
      askedFrom: placement.askedFrom,
      carrierNameInDocument: mapped.carrierName,
      fields: mapped.fields,
      noted: mapped.noted,
    });
    if (!args) return end("error", "bad_card");
    const persisted = await persistEngineProposal(
      q,
      {
        kind: "pay_policy_setup",
        subjectTable: "pay_configs",
        subjectId: placement.base.id,
        amountCents: 0,
        args,
        exceptions: [...exceptions],
        reasons: ["from_policy_document"],
        sources: [
          { table: "untrusted_inputs", id: begun.inputId },
          { table: "pay_configs", id: placement.base.id },
        ],
      },
      session,
      now,
    );
    if (persisted.kind === "live_exists") return end("live_exists", "live_exists");
    if (persisted.kind === "already_decided") return end("already_decided", "already_decided");
    await finishStep(
      q,
      run.turnId,
      begun.stepId,
      {
        state: "done",
        modelCallId: callId,
        proposalId: persisted.proposalId,
        detail: { found: counts.found, needsYou: counts.needsYou, notInDocument: counts.notInDocument },
      },
      now,
    );
    await mark(q, run, { map: "done", check: "done", flag: "done", card: "doing" });
    return;
  }

  if (begun.kind === "check" && done.kind === "check") {
    const r = done.result;
    const detail: Record<string, unknown> = { audit: r ? r.state : "error" };
    if (r && r.state === "done") detail.verdict = r.verdict;
    await finishStep(q, run.turnId, begun.stepId, { state: r ? "done" : "failed", detail }, now);
    await endRun(q, run, "card_ready", now);
  }
}

// One stage of the run. busy: another request is running a stage of this turn now.
export async function advancePolicyRun(session: Session, turnId: string, deps: RunDeps = {}): Promise<AdvanceOutcome> {
  if (!flags.policyOnboardEnabled) return { ok: false, error: "disabled" };
  if (!UUID.test(turnId)) return { ok: false, error: "not_found" };
  const db = deps.db ?? getDb();
  const clock = clockOf(deps);
  const prep = await withAgentTenant(db, session, (q) => prepare(q, session, turnId, clock()));
  if (prep.kind === "not_found") return { ok: false, error: "not_found" };
  let busy = prep.kind === "busy";
  if (prep.kind === "work") {
    const done = await work(prep.begun, prep.run, session, clock(), deps);
    try {
      await withAgentTenant(db, session, async (q) => {
        // The lock again, so a stale-step pass cannot run between the check and the writes.
        const turn = await readRunTurn(q, session.sub, turnId, { lock: true });
        if (!turn || turn.status !== "running") throw new Error("turn step not finished");
        prep.run.states = statesOf(turn.checklist);
        await finish(q, session, prep.run, prep.begun, done, clock());
      });
    } catch (err) {
      // The step was failed as stale meanwhile, the turn ended, or another run read the same file
      // first: nothing of this stage is kept, and the next pass picks up from the stored rows.
      if (!(err instanceof Error && LOST.has(err.message))) throw err;
      busy = true;
    }
  }
  const view = await readPolicyRun(session, turnId, deps);
  if (!view) return { ok: false, error: "not_found" };
  return { ok: true, view, busy };
}
