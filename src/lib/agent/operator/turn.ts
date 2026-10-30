import { flags } from "../../../config/flags";
import type { Session } from "../../auth/claims";
import { AiError, complete, type AiMessage, type AiReplayItem, type AiResult, type AiTool } from "../../ai";
import { finalChecklist, modelChecklist, sameChecklist, type Checklist, type ChecklistDraft } from "../checklist";
import { callTool, reportRefOf, toolNamed, toolsFor, TOOL_REGISTRY } from "../gateway";
import { dbTurnStore, engineCompares, type OpenedTurn, type StepFinish, type TurnStore } from "../gateway/store";
import type { CompleteFn, GatewayContext, GatewayOutcome, ToolCall } from "../gateway/types";
import {
  CALL_MARGIN_MS,
  CHECKLIST_TOOL,
  ESCALATE_AFTER_INVALID,
  ESCALATION_CALL,
  escalatedText,
  LOOP_TEXT,
  OPERATOR_CALL,
  operatorPrompt,
  TURN_SUMMARY_CHARS,
  invalidArgsNote,
  operatorCacheKey,
  verifyAttempts,
} from "../policy";
import { stopSummary } from "../stop-summary";
import { verificationNote } from "../verify/note";
import { gatewayVerification, persistVerification, type PersistRefusal, type ProposalVerification } from "../verify/required";
import type { StepView } from "../view";
import { TurnBudget, type CapReason, type TurnLimits } from "./budget";
import { idsIn, validateRefs } from "./citations";
import { centsIn, maskFigures, typedCentsIn } from "./figures";
import type { TurnEmitter } from "./stream";

// The operator loop (design 2.2): short Muse Spark turns over a compact state summary, every
// tool call through the gateway, hard caps on steps, model calls, cents and the clock, one
// escalation to Muse Wonder after two schema failures, and a fixed budget state. The loop reads,
// explains and proposes; it never moves money and holds no path to the ledger.
//
// This is the one agent file that may import the model wrapper (the import-boundary test).

export { AiError };

// How the operator's Muse Spark calls are shaped: tool search over the deferred tools, and the
// shared prompt cache key. Both off sends today's request unchanged.
export type TurnRequest = {
  toolSearch: boolean;
  cache: { key: string; retention: "in_memory" | "24h" } | null;
};

const PLAIN_REQUEST: TurnRequest = { toolSearch: false, cache: null };

export type TurnDeps = {
  complete: CompleteFn;
  callTool: (ctx: GatewayContext, call: ToolCall) => Promise<GatewayOutcome>;
  store: TurnStore;
  tools: AiTool[];
  clock: () => number;
  limits: TurnLimits;
  emit?: TurnEmitter;
  // Absent means both off.
  request?: TurnRequest;
  // The checks inside the submit (flags.verification, design-agents-102 3.2). Absent or off is
  // today's loop exactly.
  verification?: { enabled: boolean; maxAttempts: number };
};

export type TurnInput = { session: Session; turn: OpenedTurn; text: string; startedAt: number };

export type TurnOutcome = {
  status: "done" | "partial" | "failed";
  endedReason: string | null;
  text: string;
  stepCount: number;
  modelCallCount: number;
  costNanocents: number;
};

// The flags are read here, once per turn.
export function defaultTurnDeps(session: Session, emit?: TurnEmitter): TurnDeps {
  const tools = toolsFor("operator", { defer: flags.agentToolSearch });
  const verification = { enabled: flags.verification.enabled, maxAttempts: flags.verification.maxAttempts };
  return {
    complete: (target, request, s) => complete(target, request, s),
    callTool: (ctx, call) => callTool(ctx, call),
    store: dbTurnStore(session),
    tools,
    clock: Date.now,
    // The one ceiling over every run rides with the turn's own caps; the smaller one stops it.
    limits: { ...flags.agentTurnLimits, maxTurns: flags.runLimits.maxTurns },
    emit,
    request: turnRequest(tools, flags.agentToolSearch, flags.agentPromptCache, verification.enabled),
    verification,
  };
}

// Search only when a tool is actually deferred (the API refuses it otherwise), and a cache key
// built from the static prompt (with the verification rule when verify is on) and the tools as
// they will be sent.
export function turnRequest(
  tools: readonly AiTool[],
  toolSearch: boolean,
  cache: { enabled: boolean; retention: "in_memory" | "24h" },
  verify = false,
): TurnRequest {
  const search = toolSearch && tools.some((t) => t.deferLoading === true);
  return {
    toolSearch: search,
    cache: cache.enabled
      ? {
          key: operatorCacheKey(operatorPrompt(tools.map((t) => t.name), search, verify), tools),
          retention: cache.retention,
        }
      : null,
  };
}

const MODEL_LABEL = "Thinking it through";
const ESCALATION_LABEL = "Asking Muse Wonder to form the proposal";
const PROPOSAL_LABEL = "Preparing a proposal card";
const PERSON_LABEL = "Escalated to a person";
const UNKNOWN_TOOL_LABEL = "Checking a tool";
const CHECKLIST_UPDATED_LABEL = "Updated the checklist";

// The fixed label the registry holds for a tool that is switched on; never the name the model
// typed, and never a switched-off tool's label for a call the gateway will refuse.
function labelFor(name: string): string {
  return toolNamed(name)?.label ?? UNKNOWN_TOOL_LABEL;
}

function toolNameFor(name: string): string {
  return Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name) ? name : "unknown";
}

// A propose-tier tool by the registry's own entry, switched on or not: only these are verified.
function isProposeTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name) && TOOL_REGISTRY[name].tier === "propose";
}

const CODE = /^[a-z_]{2,40}$/;

// What the model is told for a refused proposal while verification is on: the gateway's codes and
// limit by name, and the fixed note. Any other field a result carries is left out, so no upstream
// text reaches the model through a refusal.
function refusedBody(result: Record<string, unknown>, note: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (result.blocked === true) body.blocked = true;
  if (result.proposed === false) body.proposed = false;
  if (typeof result.reason === "string" && CODE.test(result.reason)) body.reason = result.reason;
  if (typeof result.limitCents === "number" && Number.isSafeInteger(result.limitCents)) body.limitCents = result.limitCents;
  if (typeof result.category === "string" && CODE.test(result.category)) body.category = result.category;
  body.note = note;
  return body;
}

function summaryLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TURN_SUMMARY_CHARS);
}

type Ending = { status: TurnOutcome["status"]; endedReason: string | null; text: string };

// A message as the escalation to Muse Wonder sends it: today's shape, with no input placement and
// no tool search items (Wonder's call offers neither search nor the cache). A message with
// neither is passed as it is.
function plainMessage(m: AiMessage): AiMessage {
  if (m.role === "system" && m.placement !== undefined) return { role: "system", content: m.content };
  if (m.role === "assistant" && m.replay !== undefined) {
    return m.toolCalls ? { role: "assistant", content: m.content, toolCalls: m.toolCalls } : { role: "assistant", content: m.content };
  }
  return m;
}

export async function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnOutcome> {
  const { session, turn } = input;
  const request = deps.request ?? PLAIN_REQUEST;
  const budget = new TurnBudget(deps.limits, input.startedAt, deps.clock);
  // The checks inside the submit, when on: tries per propose tool at the card in hand (a card made
  // starts the count again for the next one), and the try that sends the request to a person.
  const verify = deps.verification?.enabled === true;
  const maxAttempts = verifyAttempts(deps.verification?.maxAttempts ?? 0);
  const attempts = new Map<string, number>();
  let toPerson = null as { toolName: string; attempts: number } | null;
  // With the cache on, the state summary (this tenant's data) goes in input after the static
  // prompt, so the prompt and the tools stay one prefix every tenant shares.
  const messages: AiMessage[] = [
    { role: "system", content: operatorPrompt(deps.tools.map((t) => t.name), request.toolSearch, verify) },
    request.cache
      ? { role: "system", content: turn.summary, placement: "input" }
      : { role: "system", content: turn.summary },
    { role: "user", content: input.text },
  ];
  const allowedCents = new Set<number>(turn.summaryCents.map((n) => Math.abs(n)));
  // The person's own figures in what they typed this turn ("Can Sam get $500?") may be said back.
  typedCentsIn(input.text, allowedCents);
  const trusted = new Set<string>();
  const invalid = new Map<string, number>();
  let stepCount = 0;
  let toolsDone = 0;
  let escalated = false;
  let flaggedInputId: string | null = null;
  let lastText = "";
  let replay: AiReplayItem[] = [];
  // The answer's checklist as last set (figures masked), or null when it set none.
  let checklist: Checklist | null = null;
  // Which Muse Spark response is under way, the last one that set the checklist, and the last one
  // in which a call other than the checklist was refused or made no card. A list sent in a later
  // response was written knowing how that call went; one sent in the same response was not.
  let response = 0;
  let listResponse = 0;
  let refusedResponse = 0;

  const emitStep = (s: StepView) => deps.emit?.({ event: "step", data: s });
  const start = async (kind: StepView["kind"], label: string) => {
    const s = await deps.store.startStep(turn.turnId, { kind, label });
    stepCount += 1;
    emitStep(s);
    return s;
  };
  const finish = async (s: StepView, state: "done" | "failed", extra: Omit<StepFinish, "state">) => {
    const done = await deps.store.finishStep(turn.turnId, s.id, { state, ...extra });
    emitStep(done);
  };
  const ctxFor = (model: GatewayContext["model"]): GatewayContext => ({
    session,
    role: "operator",
    model,
    turnId: turn.turnId,
    traceId: turn.traceId,
    now: new Date(deps.clock()),
    deadlineAt: budget.deadlineAt,
    timeZone: turn.timeZone,
    // The person's own sentence: a pay rule change's new value must appear in it.
    userText: input.text,
    // Once a tool has read flagged outside text, every later call in this turn carries it.
    ...(flaggedInputId !== null ? { flaggedInputId } : {}),
  });

  // One model call, with the turn's caps applied to its cost and time.
  const modelCall = async (
    target: "spark" | "wonder",
    tools: AiTool[],
  ): Promise<{ result: AiResult } | { error: string; reducedCap: boolean }> => {
    const policy = target === "spark" ? OPERATOR_CALL : ESCALATION_CALL;
    const cap = Math.min(policy.maxCostCents, budget.centsLeft());
    const remaining = budget.remainingMs() - CALL_MARGIN_MS;
    const timeoutMs =
      target === "spark" ? remaining : Math.min(ESCALATION_CALL.maxTimeoutMs, remaining);
    try {
      const result = await deps.complete(
        target,
        {
          purpose: policy.purpose,
          messages: target === "spark" ? messages : messages.map(plainMessage),
          tools,
          reasoningEffort: policy.reasoningEffort,
          maxOutputTokens: policy.maxOutputTokens,
          maxCostCents: cap,
          timeoutMs: Math.max(1_000, Math.floor(timeoutMs)),
          traceId: turn.traceId,
          ...(target === "spark" && replay.length > 0 ? { replay } : {}),
          // Muse Spark only: the escalation to Muse Wonder keeps today's request shape.
          ...(target === "spark" && request.toolSearch ? { toolSearch: true } : {}),
          ...(target === "spark" && request.cache ? { cache: request.cache } : {}),
        },
        session,
      );
      budget.addModelCall(result.costNanocents);
      return { result };
    } catch (err) {
      const category = err instanceof AiError ? err.category : "unknown";
      return { error: category, reducedCap: cap < policy.maxCostCents };
    }
  };

  // One tool call through the gateway, its step, and (for an allowed proposal) its card. counted
  // false is only the first checklist write of a model response: it reads nothing, so the step
  // cap (which bounds reads and cards) is not spent on it, and the model-call cap bounds how many
  // such writes a turn can make.
  const dispatch = async (
    call: ToolCall,
    model: "spark" | "wonder",
    counted = true,
  ): Promise<GatewayOutcome> => {
    const label = call.name === CHECKLIST_TOOL && checklist ? CHECKLIST_UPDATED_LABEL : labelFor(call.name);
    const step = await start("tool", label);
    let outcome: GatewayOutcome;
    try {
      outcome = await deps.callTool(ctxFor(model), call);
    } catch {
      outcome = {
        decision: "failed",
        decisionId: "",
        tool: toolNameFor(call.name),
        reason: "tool_failed",
        result: { error: "tool_failed" },
        latencyMs: 0,
      };
    }
    if (counted) budget.addToolStep();
    const report = outcome.decision === "allowed" ? reportRefOf(outcome.tool, outcome.result) : null;
    if (outcome.decision === "allowed" && outcome.checklist) await keepChecklist(outcome.checklist);
    if (outcome.decision === "allowed") {
      toolsDone += 1;
      centsIn(outcome.result, allowedCents);
      idsIn(outcome.result, trusted);
      if (outcome.flaggedInputId && !flaggedInputId) {
        flaggedInputId = outcome.flaggedInputId;
        await deps.store.flagTurnProposals(turn.turnId, flaggedInputId);
      }
    } else if (typeof outcome.limitCents === "number") {
      allowedCents.add(Math.abs(outcome.limitCents));
    }
    // With verification on, a propose tool's call that passed the schema is one try at the card:
    // a gateway refusal, or an allowed draft checked here against the case record and the engine
    // before its step is finished and before anything is saved. A switched-off tool never ran a
    // check, so it is no try.
    const tried =
      verify &&
      isProposeTool(call.name) &&
      (outcome.decision === "allowed" ? Boolean(outcome.draft) : outcome.decision === "blocked" && outcome.reason !== "disabled");
    const attempt = tried ? (attempts.get(call.name) ?? 0) + 1 : 0;
    if (tried) attempts.set(call.name, attempt);
    const checked = tried && outcome.decision === "allowed" ? await checkDraft(outcome, model) : null;
    const verification: ProposalVerification | null = !tried
      ? null
      : checked
        ? checked.verification
        : gatewayVerification(outcome.reason);
    const refused = tried && (outcome.decision !== "allowed" || checked?.refusal != null);
    await finish(step, outcome.decision === "allowed" && !refused ? "done" : "failed", {
      gatewayDecisionId: outcome.decisionId || null,
      detail: {
        tool: toolNameFor(call.name),
        decision: outcome.decision,
        reason: outcome.reason,
        ...(outcome.decision === "allowed" && outcome.flaggedInputId
          ? { flaggedInputId: outcome.flaggedInputId }
          : {}),
        // A report's name and typed args (dates and ids), so the chat can show its table again.
        ...(report ? { report } : {}),
        // The try and its checks, as fixed codes (design-agents-102 3.2).
        ...(verification
          ? { attempt, layer: "checks", verification, ...(checked?.refusal ? { refusal: checked.refusal } : {}) }
          : {}),
      },
    });
    if (refused) settle(call.name, attempt, true);
    if (outcome.decision === "allowed" && outcome.draft) {
      if (checked?.refusal) {
        refusedResponse = response;
        const note = verificationNote(attempt, maxAttempts, [checked.refusal]);
        return { ...outcome, result: refusedBody({ proposed: false, reason: checked.refusal }, note) };
      }
      const result = await persist(outcome, checked ? { sources: checked.sources, engine: checked.engine, attempt } : undefined);
      if (result.proposed === false) refusedResponse = response;
      // A try the store did not card (a live card already, decided, or the store failed) is a
      // refused try too, so the count never passes the limit.
      if (tried) settle(call.name, attempt, result.proposed === false);
      return { ...outcome, result };
    }
    if (outcome.decision !== "allowed" && call.name !== CHECKLIST_TOOL) refusedResponse = response;
    if (tried && outcome.decision !== "allowed") {
      const note = verificationNote(attempt, maxAttempts, [outcome.reason], outcome.limitCents);
      return { ...outcome, result: refusedBody(outcome.result, note) };
    }
    return outcome;
  };

  // A try that ended in a card starts the count again for the next card, so an attempt number is
  // always a try at the card in hand (1 to the limit); a refused try at the limit sends the
  // request to a person.
  const settle = (name: string, attempt: number, refused: boolean) => {
    if (!refused) attempts.delete(name);
    else if (attempt >= maxAttempts) toPerson = { toolName: toolNameFor(name), attempts: attempt };
  };

  // The draft's citations the turn can stand behind: the engine's own sources are trusted; the
  // model's sourceRefs only if a tool returned them.
  const citedSources = (outcome: Extract<GatewayOutcome, { decision: "allowed" }>) => {
    const draft = outcome.draft!;
    const modelRefs = new Set(
      outcome.refs.map((r) => `${r.table}:${r.id.toLowerCase()}`),
    );
    const engineIds = new Set(
      draft.sources
        .filter((r) => !modelRefs.has(`${r.table}:${r.id.toLowerCase()}`))
        .map((r) => r.id.toLowerCase()),
    );
    return validateRefs(draft.sources, new Set([...trusted, ...engineIds, draft.subjectId.toLowerCase()]));
  };

  // The two checks before the insert, while verification is on (design-agents-102 3.2): at least
  // one citation is from the case record, and a kind the engine compares recomputes to the cent.
  // A kind it never compares skips the recompute and is not refused for it. No time left, a read
  // error, an engine refusal or no figure is unknown, and unknown refuses the draft.
  const checkDraft = async (
    outcome: Extract<GatewayOutcome, { decision: "allowed" }>,
    model: "spark" | "wonder",
  ): Promise<{
    sources: ReturnType<typeof validateRefs>;
    engine?: { check: "matched"; engineCents: number | null };
    refusal: PersistRefusal | null;
    verification: ProposalVerification;
  }> => {
    const draft = outcome.draft!;
    const sources = citedSources(outcome);
    if (sources.length === 0) {
      return { sources, refusal: "citation_not_in_record", verification: persistVerification("citation_not_in_record", false) };
    }
    if (!engineCompares(draft.kind)) return { sources, refusal: null, verification: persistVerification(null, false) };
    let result: Awaited<ReturnType<TurnStore["checkDraft"]>> = null;
    if (budget.remainingMs() > 0) {
      try {
        result = await deps.store.checkDraft(draft, ctxFor(model));
      } catch {
        result = null;
      }
    }
    if (result?.check === "matched") {
      return {
        sources,
        engine: { check: "matched", engineCents: result.engineCents },
        refusal: null,
        verification: persistVerification(null, true),
      };
    }
    const refusal: PersistRefusal = result?.check === "mismatch" ? "engine_mismatch" : "limit_unavailable";
    return { sources, refusal, verification: persistVerification(refusal, false) };
  };

  // The checklist set_checklist returned: figures the records did not give are withheld, as in an
  // answer, then it is stored on the turn and shown. It changes nothing else.
  const keepChecklist = async (draft: ChecklistDraft) => {
    const list = modelChecklist(draft, allowedCents);
    await deps.store.setChecklist(turn.turnId, list);
    checklist = list;
    listResponse = response;
    deps.emit?.({ event: "checklist", data: list });
  };

  // The card for an allowed propose_* outcome. What the model is told back replaces the tool's
  // result: created, the same card again, or refused because one is already waiting or the same
  // proposal was already decided. Only created and a live duplicate say proposed.
  // checked: the verified try (flags.verification on), with the citations and the engine's match
  // already worked out; the insert stores the match. Absent is today's card exactly.
  const persist = async (
    outcome: Extract<GatewayOutcome, { decision: "allowed" }>,
    checked?: {
      sources: ReturnType<typeof validateRefs>;
      engine?: { check: "matched"; engineCents: number | null };
      attempt: number;
    },
  ): Promise<Record<string, unknown>> => {
    const draft = outcome.draft!;
    const step = await start("proposal", PROPOSAL_LABEL);
    const sources = checked ? checked.sources : citedSources(outcome);
    try {
      const saved = await deps.store.persistProposal({
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        traceId: turn.traceId,
        draft: { ...draft, sources: sources as typeof draft.sources },
        gatewayDecisionId: outcome.decisionId,
        flaggedInputId,
        ...(checked?.engine ? { engine: checked.engine } : {}),
      });
      const carded = saved.kind === "created" || saved.kind === "duplicate";
      await finish(step, carded ? "done" : "failed", {
        proposalId: carded ? saved.proposalId : null,
        detail: {
          result: saved.kind,
          droppedRefs: draft.sources.length - sources.length,
          ...(saved.kind === "already_decided" ? { status: saved.status } : {}),
          ...(checked ? { attempt: checked.attempt, ...(carded ? { accepted: true } : {}) } : {}),
        },
      });
      if (saved.kind === "live_exists") {
        return { proposed: false, reason: "live_proposal_exists", proposalId: saved.proposalId };
      }
      if (saved.kind === "already_decided") {
        return { proposed: false, reason: "already_decided", proposalId: saved.proposalId };
      }
      return {
        ...outcome.result,
        proposed: true,
        proposalId: saved.proposalId,
        ...(saved.kind === "duplicate" ? { duplicate: true } : {}),
        ...(saved.flagged ? { flagged: true } : {}),
      };
    } catch {
      await finish(step, "failed", { detail: { result: "store_failed", ...(checked ? { attempt: checked.attempt } : {}) } });
      return { proposed: false, reason: "tool_failed" };
    }
  };

  const toolMessage = (call: ToolCall, outcome: GatewayOutcome): AiMessage => {
    const body: Record<string, unknown> = { ...outcome.result };
    if (outcome.decision === "invalid_args") {
      body.note = invalidArgsNote(outcome.fieldErrors ?? []);
    }
    return { role: "tool", toolCallId: call.id, content: JSON.stringify(body) };
  };

  const stopped = (cap: CapReason): Ending => ({
    status: "partial",
    endedReason: cap,
    text: lastText ? `${LOOP_TEXT.stopped}\n\n${lastText}` : LOOP_TEXT.stopped,
  });
  const modelFailed = (category: string, reducedCap: boolean): Ending => {
    // A demo visit hits its own budget (src/lib/ai/spend.ts), so it gets its own line.
    if (category === "cap") {
      const text = session.demoSessionId ? LOOP_TEXT.visitBudget : LOOP_TEXT.budget;
      return { status: "failed", endedReason: "budget", text };
    }
    if (category === "job_cap") return { status: "failed", endedReason: "job_cap", text: LOOP_TEXT.jobCap };
    if (category === "too_expensive" && reducedCap) return stopped("cents");
    if (category === "disabled") return { status: "failed", endedReason: "ai_off", text: LOOP_TEXT.failed };
    const reason = `model_${category}`.slice(0, 40);
    return toolsDone > 0
      ? { status: "partial", endedReason: reason, text: lastText ? `${LOOP_TEXT.stopped}\n\n${lastText}` : LOOP_TEXT.stopped }
      : { status: "failed", endedReason: reason, text: LOOP_TEXT.failed };
  };
  const schemaEnd = (): Ending => ({ status: "partial", endedReason: "schema", text: LOOP_TEXT.schema });

  // The last refused try at a card (design-agents-102 3.2): one escalation step for a person, then
  // the turn ends with no further model call. No card exists for the request.
  const personEnd = async (e: { toolName: string; attempts: number }): Promise<Ending> => {
    const step = await start("escalation", PERSON_LABEL);
    await finish(step, "failed", {
      detail: { reason: "verification_failed", attempts: e.attempts, finishedBy: "person", toolName: e.toolName },
    });
    return { status: "partial", endedReason: "escalated", text: escalatedText(e.attempts) };
  };

  // The one escalation: Muse Wonder gets the same messages and only the tool that failed. The
  // turn's caps hold here too: no Wonder call without a model call and a tool step left for it,
  // and no dispatch past the step cap or the clock.
  const escalate = async (toolName: string): Promise<"ok" | "failed"> => {
    escalated = true;
    const step = await start("escalation", ESCALATION_LABEL);
    const detail = { reason: "schema_failed_twice", attempts: ESCALATE_AFTER_INVALID, from: "spark", toolName };
    const callCap = budget.beforeModelCall() ?? budget.beforeToolStep();
    if (callCap) {
      await finish(step, "failed", { detail: { ...detail, finishedBy: "none", category: callCap } });
      return "failed";
    }
    // Sent in full: Wonder's call offers no search, so a deferred tool would be refused. A tool
    // that was never deferred goes as it is, so the request is today's with the flags off.
    const tools = deps.tools
      .filter((t) => t.name === toolName)
      .map((t) => (t.deferLoading ? { ...t, deferLoading: false } : t));
    const called = tools.length === 1 ? await modelCall("wonder", tools) : { error: "unknown", reducedCap: false };
    if ("error" in called) {
      await finish(step, "failed", { detail: { ...detail, finishedBy: "none", category: called.error } });
      return "failed";
    }
    const call = called.result.toolCalls.find((c) => c.name === toolName);
    if (!call) {
      await finish(step, "failed", { modelCallId: called.result.callId, detail: { ...detail, finishedBy: "none" } });
      return "failed";
    }
    const stepCap = budget.beforeToolStep();
    if (stepCap) {
      await finish(step, "failed", {
        modelCallId: called.result.callId,
        detail: { ...detail, finishedBy: "none", category: stepCap },
      });
      return "failed";
    }
    await finish(step, "done", { modelCallId: called.result.callId, detail: { ...detail, finishedBy: "wonder" } });
    // Spark's reasoning items never go to Wonder, and Wonder's never come back to Spark.
    replay = [];
    messages.push({ role: "assistant", content: called.result.text, toolCalls: [call] });
    const outcome = await dispatch({ ...call, modelCallId: called.result.callId }, "wonder");
    messages.push(toolMessage(call, outcome));
    return outcome.decision === "invalid_args" ? "failed" : "ok";
  };

  const loop = async (): Promise<Ending> => {
    for (;;) {
      const cap = budget.beforeModelCall();
      if (cap) return stopped(cap);
      const step = await start("model", MODEL_LABEL);
      const called = await modelCall("spark", deps.tools);
      if ("error" in called) {
        await finish(step, "failed", { detail: { category: called.error } });
        return modelFailed(called.error, called.reducedCap);
      }
      const { result } = called;
      response += 1;
      // Figures the tools did not return, and the person did not type, are withheld before the
      // text is kept anywhere.
      const shown = maskFigures(result.text.trim(), allowedCents);
      const note = result.reasoningSummary ? maskFigures(result.reasoningSummary.trim(), allowedCents).text : "";
      await finish(step, "done", {
        modelCallId: result.callId,
        ...(note ? { reasoningNote: note } : {}),
        detail: {
          status: result.status,
          toolCalls: result.toolCalls.length,
          toolSearches: result.toolSearches,
          textChars: result.text.length,
          maskedFigures: shown.masked,
        },
      });
      if (shown.text) lastText = shown.text;
      if (result.toolCalls.length === 0) {
        if (!shown.text) {
          const reason = result.status === "incomplete" ? "incomplete" : "empty";
          return { status: "partial", endedReason: reason, text: LOOP_TEXT.empty };
        }
        return { status: "done", endedReason: null, text: shown.text };
      }
      // The answer's tool search items stay pinned to it, so every later call sends them back
      // before its tool calls; its reasoning goes back with the next call only.
      const searched = result.replay.filter((item) => item.type !== "reasoning");
      messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls,
        ...(searched.length > 0 ? { replay: searched } : {}),
      });
      replay = result.replay;
      // Parallel calls run one by one, in the order returned, so the step cap is exact. The
      // first checklist write in a response is not a counted step; it still waits on the clock.
      let checklistWritten = false;
      for (let i = 0; i < result.toolCalls.length; i += 1) {
        const call = result.toolCalls[i];
        const free = call.name === CHECKLIST_TOOL && !checklistWritten;
        if (free) checklistWritten = true;
        const stepCap = free ? (budget.remainingMs() <= 0 ? "clock" : null) : budget.beforeToolStep();
        if (stepCap) return stopped(stepCap);
        const outcome = await dispatch({ ...call, modelCallId: result.callId }, "spark", !free);
        messages.push(toolMessage(call, outcome));
        // The rest of this response's calls are not run: the request goes to a person.
        if (toPerson) return await personEnd(toPerson);
        if (outcome.decision !== "invalid_args") continue;
        // A checklist the schema refused is told back to the model and left there: it never
        // escalates to Muse Wonder and never ends the answer.
        if (call.name === CHECKLIST_TOOL) continue;
        const name = toolNameFor(call.name);
        const count = (invalid.get(name) ?? 0) + 1;
        invalid.set(name, count);
        if (count > ESCALATE_AFTER_INVALID) return schemaEnd();
        if (count === ESCALATE_AFTER_INVALID && name !== "unknown") {
          if (escalated || budget.remainingMs() < ESCALATION_CALL.minRemainingMs) continue;
          // The rest of this response's calls are answered as skipped, so every call has a result.
          for (const skipped of result.toolCalls.slice(i + 1)) {
            messages.push({
              role: "tool",
              toolCallId: skipped.id,
              content: JSON.stringify({ skipped: true }),
            });
          }
          const formed = await escalate(name);
          if (toPerson) return await personEnd(toPerson);
          if (formed === "failed") return schemaEnd();
          break;
        }
      }
    }
  };

  // A store write that fails mid-turn throws; the route records the turn as failed.
  const ended = await loop();
  // The checklist as the answer ended: the item in hand is done when it finished and not done
  // when it stopped; one never started is not done. A call refused, or a proposal that made no
  // card, after the list was last sent leaves the item in hand not done even on a finished answer:
  // never a check beside a card that does not exist. A stop then says what was done and what is
  // left in place of the plain stop line, still followed by what was found. Its count is the
  // tool steps the step cap counted, not the model calls.
  const unsettled = refusedResponse > 0 && refusedResponse >= listResponse;
  const finalList = checklist ? finalChecklist(checklist, ended.status === "done" && unsettled ? "partial" : ended.status) : null;
  // An escalation to a person keeps its own line, followed by the same summary.
  const ending: Ending =
    finalList && ended.status === "partial" && ended.text.startsWith(LOOP_TEXT.stopped)
      ? { ...ended, text: `${stopSummary(finalList, { steps: budget.toolSteps })}${ended.text.slice(LOOP_TEXT.stopped.length)}` }
      : finalList && ended.endedReason === "escalated"
        ? { ...ended, text: `${ended.text}\n\n${stopSummary(finalList, { steps: budget.toolSteps })}` }
        : ended;
  if (finalList && !sameChecklist(finalList, checklist)) deps.emit?.({ event: "checklist", data: finalList });
  await deps.store.finishTurn(turn.turnId, {
    status: ending.status,
    endedReason: ending.endedReason,
    text: ending.text,
    summary: summaryLine(ending.text),
    stepCount,
    modelCallCount: budget.modelCalls,
    costNanocents: budget.costNanocents,
    ...(finalList ? { checklist: finalList } : {}),
  });
  return {
    status: ending.status,
    endedReason: ending.endedReason,
    text: ending.text,
    stepCount,
    modelCallCount: budget.modelCalls,
    costNanocents: budget.costNanocents,
  };
}
