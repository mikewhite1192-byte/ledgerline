import { flags } from "../../../config/flags";
import type { Session } from "../../auth/claims";
import { AiError, complete, type AiMessage, type AiReplayItem, type AiResult, type AiTool } from "../../ai";
import { callTool, reportRefOf, toolNamed, toolsFor, TOOL_REGISTRY } from "../gateway";
import { dbTurnStore, type OpenedTurn, type StepFinish, type TurnStore } from "../gateway/store";
import type { CompleteFn, GatewayContext, GatewayOutcome, ToolCall } from "../gateway/types";
import {
  CALL_MARGIN_MS,
  ESCALATE_AFTER_INVALID,
  ESCALATION_CALL,
  LOOP_TEXT,
  OPERATOR_CALL,
  operatorPrompt,
  TURN_SUMMARY_CHARS,
  invalidArgsNote,
} from "../policy";
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

export type TurnDeps = {
  complete: CompleteFn;
  callTool: (ctx: GatewayContext, call: ToolCall) => Promise<GatewayOutcome>;
  store: TurnStore;
  tools: AiTool[];
  clock: () => number;
  limits: TurnLimits;
  emit?: TurnEmitter;
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

export function defaultTurnDeps(session: Session, emit?: TurnEmitter): TurnDeps {
  return {
    complete: (target, request, s) => complete(target, request, s),
    callTool: (ctx, call) => callTool(ctx, call),
    store: dbTurnStore(session),
    tools: toolsFor("operator"),
    clock: Date.now,
    limits: flags.agentTurnLimits,
    emit,
  };
}

const MODEL_LABEL = "Thinking it through";
const ESCALATION_LABEL = "Asking Muse Wonder to form the proposal";
const PROPOSAL_LABEL = "Preparing a proposal card";
const UNKNOWN_TOOL_LABEL = "Checking a tool";

// The fixed label the registry holds for a tool that is switched on; never the name the model
// typed, and never a switched-off tool's label for a call the gateway will refuse.
function labelFor(name: string): string {
  return toolNamed(name)?.label ?? UNKNOWN_TOOL_LABEL;
}

function toolNameFor(name: string): string {
  return Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name) ? name : "unknown";
}

function summaryLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TURN_SUMMARY_CHARS);
}

type Ending = { status: TurnOutcome["status"]; endedReason: string | null; text: string };

export async function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnOutcome> {
  const { session, turn } = input;
  const budget = new TurnBudget(deps.limits, input.startedAt, deps.clock);
  const messages: AiMessage[] = [
    { role: "system", content: operatorPrompt(deps.tools.map((t) => t.name)) },
    { role: "system", content: turn.summary },
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
          messages,
          tools,
          reasoningEffort: policy.reasoningEffort,
          maxOutputTokens: policy.maxOutputTokens,
          maxCostCents: cap,
          timeoutMs: Math.max(1_000, Math.floor(timeoutMs)),
          traceId: turn.traceId,
          ...(target === "spark" && replay.length > 0 ? { replay } : {}),
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

  // One tool call through the gateway, its step, and (for an allowed proposal) its card.
  const dispatch = async (call: ToolCall, model: "spark" | "wonder"): Promise<GatewayOutcome> => {
    const step = await start("tool", labelFor(call.name));
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
    budget.addToolStep();
    const report = outcome.decision === "allowed" ? reportRefOf(outcome.tool, outcome.result) : null;
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
    await finish(step, outcome.decision === "allowed" ? "done" : "failed", {
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
      },
    });
    if (outcome.decision === "allowed" && outcome.draft) {
      return { ...outcome, result: await persist(outcome) };
    }
    return outcome;
  };

  // The card for an allowed propose_* outcome. What the model is told back replaces the tool's
  // result: created, the same card again, or refused because one is already waiting or the same
  // proposal was already decided. Only created and a live duplicate say proposed.
  const persist = async (
    outcome: Extract<GatewayOutcome, { decision: "allowed" }>,
  ): Promise<Record<string, unknown>> => {
    const draft = outcome.draft!;
    const step = await start("proposal", PROPOSAL_LABEL);
    const modelRefs = new Set(
      outcome.refs.map((r) => `${r.table}:${r.id.toLowerCase()}`),
    );
    // The engine's own sources are trusted; the model's sourceRefs only if a tool returned them.
    const engineIds = new Set(
      draft.sources
        .filter((r) => !modelRefs.has(`${r.table}:${r.id.toLowerCase()}`))
        .map((r) => r.id.toLowerCase()),
    );
    const sources = validateRefs(draft.sources, new Set([...trusted, ...engineIds, draft.subjectId.toLowerCase()]));
    try {
      const saved = await deps.store.persistProposal({
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        traceId: turn.traceId,
        draft: { ...draft, sources: sources as typeof draft.sources },
        gatewayDecisionId: outcome.decisionId,
        flaggedInputId,
      });
      const carded = saved.kind === "created" || saved.kind === "duplicate";
      await finish(step, carded ? "done" : "failed", {
        proposalId: carded ? saved.proposalId : null,
        detail: {
          result: saved.kind,
          droppedRefs: draft.sources.length - sources.length,
          ...(saved.kind === "already_decided" ? { status: saved.status } : {}),
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
      await finish(step, "failed", { detail: { result: "store_failed" } });
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
    if (category === "cap") return { status: "failed", endedReason: "budget", text: LOOP_TEXT.budget };
    if (category === "too_expensive" && reducedCap) return stopped("cents");
    if (category === "disabled") return { status: "failed", endedReason: "ai_off", text: LOOP_TEXT.failed };
    const reason = `model_${category}`.slice(0, 40);
    return toolsDone > 0
      ? { status: "partial", endedReason: reason, text: lastText ? `${LOOP_TEXT.stopped}\n\n${lastText}` : LOOP_TEXT.stopped }
      : { status: "failed", endedReason: reason, text: LOOP_TEXT.failed };
  };
  const schemaEnd = (): Ending => ({ status: "partial", endedReason: "schema", text: LOOP_TEXT.schema });

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
    const tools = deps.tools.filter((t) => t.name === toolName);
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
      // Figures the tools did not return, and the person did not type, are withheld before the
      // text is kept anywhere.
      const shown = maskFigures(result.text.trim(), allowedCents);
      await finish(step, "done", {
        modelCallId: result.callId,
        detail: {
          status: result.status,
          toolCalls: result.toolCalls.length,
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
      messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
      replay = result.replay;
      // Parallel calls run one by one, in the order returned, so the step cap is exact.
      for (let i = 0; i < result.toolCalls.length; i += 1) {
        const call = result.toolCalls[i];
        const stepCap = budget.beforeToolStep();
        if (stepCap) return stopped(stepCap);
        const outcome = await dispatch({ ...call, modelCallId: result.callId }, "spark");
        messages.push(toolMessage(call, outcome));
        if (outcome.decision !== "invalid_args") continue;
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
          if ((await escalate(name)) === "failed") return schemaEnd();
          break;
        }
      }
    }
  };

  // A store write that fails mid-turn throws; the route records the turn as failed.
  const ending = await loop();
  await deps.store.finishTurn(turn.turnId, {
    status: ending.status,
    endedReason: ending.endedReason,
    text: ending.text,
    summary: summaryLine(ending.text),
    stepCount,
    modelCallCount: budget.modelCalls,
    costNanocents: budget.costNanocents,
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
