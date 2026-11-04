import { AiError, type AiMessage, type AiResult } from "../../ai";
import { toolNamed } from "../../agent/gateway";
import type { TurnStore } from "../../agent/gateway/store";
import type { CompleteFn, GatewayContext, GatewayOutcome, ToolCall } from "../../agent/gateway/types";
import { TurnBudget } from "../../agent/operator/budget";
import { CALL_MARGIN_MS } from "../../agent/policy";
import type { Session } from "../../auth/claims";
import { refusedByProvider, type FanoutLimits } from "./limits";
import { CHECK_SHAPE, CheckAnswer, NOTE_MAX, isRecordTable, parseJson, scrubFigures, type CheckCategory } from "./schemas";

// One driver's check (design 3.3): the server reads that driver's records for one week through
// the gateway, then one Muse Spark call with no tools answers in JSON the server checks. It reads
// only; it never proposes. Its own run rather than the operator's turn (operator/turn.ts fixes
// its prompt, purpose, tools and escalation), reusing the operator's per-turn counter and writing
// turn_steps the same way. A tool loop took about three model calls a check and ran past its
// clock; the reads are fixed, so the code makes them. Caps: maxToolSteps tool steps (the four
// reads), one model call of maxCallsPerDriver, driverCents in all (callCents the call) and
// childTimeoutMs on the clock. A read the gateway does not allow ends the check before any call.

type ReadArgs = (driverId: string, week: { start: string; end: string }) => Record<string, string>;

// The reads, in order, and where each result sits in the call's message. Loads and pay items are
// the week's; the driver and the advances are whole.
export const CHECK_READS: readonly { tool: string; key: string; args: ReadArgs }[] = [
  { tool: "get_driver", key: "driver", args: (driverId) => ({ driverId }) },
  {
    tool: "get_pay_items",
    key: "payItems",
    args: (driverId, week) => ({ driverId, periodStart: week.start, periodEnd: week.end }),
  },
  { tool: "get_loads", key: "loads", args: (driverId, week) => ({ driverId, from: week.start, to: week.end }) },
  { tool: "get_advances", key: "advances", args: (driverId) => ({ driverId }) },
];

export const SEE_THE_RECORD = "see the record";
// A model call needs at least this long, or the check ends as timed out.
export const MIN_CALL_MS = 4_000;
const MAX_CALL_MS = 60_000;
// Reasoning and the answer share this cap. Measured on muse-spark-1.3 at low effort (2026-10-27):
// the answering call spent 650 to 700 tokens on reasoning alone, so a 700 cap cut every answer
// off. 3,000 leaves room for an eight-issue answer with reasoning to spare. Its reserve is about
// 1.3 cents, so callCents (5) leaves about 59 KB for the request with its read results, and each
// call's cap is also held to what the driver has left (driverCents).
const MAX_OUTPUT_TOKENS = 3_000;

export type CheckStatus = "done" | "unparsed" | "timed_out" | "budget" | "error";

export type CheckedIssue = { category: CheckCategory; sources: { table: string; id: string }[]; note: string };
export type ValidCheck = {
  driverId: string;
  checkedAll: boolean;
  confidence: "high" | "medium" | "low";
  issues: CheckedIssue[];
};

export type ChildOutcome = {
  status: CheckStatus;
  answer: ValidCheck | null;
  // What the calls cost, as the wrapper counted it. costKnown is false when a call's answer never
  // came back (a timeout, a dropped connection): its cost is unknown, never zero.
  costNanocents: number;
  costKnown: boolean;
  modelCalls: number;
  toolSteps: number;
  stepCount: number;
  droppedSources: number;
};

export type ChildInput = {
  session: Session;
  turnId: string;
  traceId: string;
  timeZone: string;
  driverId: string;
  week: { start: string; end: string };
  focus: string[];
  brief: string | null;
  limits: FanoutLimits;
  startedAt: number;
  // Nothing new starts after this (the slice's own deadline or the child's childTimeoutMs, whichever is first).
  deadlineAt: number;
};

export type ChildDeps = {
  complete: CompleteFn;
  callTool: (ctx: GatewayContext, call: ToolCall) => Promise<GatewayOutcome>;
  steps: Pick<TurnStore, "startStep" | "finishStep">;
  clock: () => number;
  // Re-read before the reads and again before the model call: the switch can go off mid-run.
  switchOn: () => boolean;
};

export const CHECK_PROMPT =
  "You check one truck driver's pay for one week. That driver's records for the week are in the " +
  "message (driver, pay items, loads, advances), read by the server from the carrier's own tables. " +
  "Report only issues you can point to a record for, citing table and id as the message shows " +
  "them (drivers, pay_items, loads, advances, or the table a pay item's ref names). Never state an " +
  "amount or any figure; name the record. Answer with a message that is only this JSON and " +
  "nothing else: " +
  CHECK_SHAPE;

const recordKey = (table: string, id: string) => `${table}:${id.toLowerCase()}`;

function rowsOf(result: Record<string, unknown>): Record<string, unknown>[] {
  const rows = result.rows;
  return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : [];
}

const idOf = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null);

// The records an allowed read returned: the only ones the check may cite (design 3.3).
export function sourcesFrom(tool: string, result: Record<string, unknown>): { table: string; id: string }[] {
  const out: { table: string; id: string }[] = [];
  const add = (table: string, id: unknown) => {
    const v = idOf(id);
    if (v && isRecordTable(table)) out.push({ table, id: v.toLowerCase() });
  };
  if (tool === "get_driver") {
    const d = result.driver;
    if (d && typeof d === "object") add("drivers", (d as Record<string, unknown>).id);
  } else if (tool === "get_pay_items") {
    for (const r of rowsOf(result)) {
      add("pay_items", r.id);
      const ref = r.ref;
      if (ref && typeof ref === "object") {
        const { table, id } = ref as Record<string, unknown>;
        if (typeof table === "string") add(table, id);
      }
    }
  } else if (tool === "get_loads") {
    for (const r of rowsOf(result)) add("loads", r.id);
  } else if (tool === "get_advances") {
    for (const r of rowsOf(result)) add("advances", r.id);
  } else if (tool === "get_ledger") {
    for (const r of rowsOf(result)) {
      add("settlement_periods", r.periodId);
      const s = r.settlement;
      if (s && typeof s === "object") add("settlements", (s as Record<string, unknown>).id);
    }
  }
  return out;
}

// The server's rules on the check's answer: it names this driver, every source is a record the
// check read this turn (others are dropped; an issue left with none is dropped), and a note with
// a figure in it becomes "see the record". Null when the answer does not parse.
export function validateCheck(
  raw: string,
  driverId: string,
  read: ReadonlySet<string>,
): { answer: ValidCheck; dropped: number } | null {
  const parsed = CheckAnswer.safeParse(parseJson(raw));
  if (!parsed.success) return null;
  if (parsed.data.driverId.toLowerCase() !== driverId.toLowerCase()) return null;
  let dropped = 0;
  const issues: CheckedIssue[] = [];
  for (const issue of parsed.data.issues) {
    const sources: { table: string; id: string }[] = [];
    for (const s of issue.sources) {
      const key = recordKey(s.table, s.id);
      if (isRecordTable(s.table) && read.has(key) && !sources.some((x) => recordKey(x.table, x.id) === key)) {
        sources.push({ table: s.table, id: s.id.toLowerCase() });
      } else {
        dropped += 1;
      }
    }
    if (sources.length === 0) continue;
    issues.push({ category: issue.category, sources, note: scrubFigures(issue.note, SEE_THE_RECORD, NOTE_MAX) });
  }
  return {
    answer: {
      driverId: driverId.toLowerCase(),
      checkedAll: parsed.data.checkedAll,
      confidence: parsed.data.confidence,
      issues,
    },
    dropped,
  };
}

// The wrapper refused these before anything was sent, so the call cost nothing.
const REFUSED_BEFORE_SENDING: ReadonlySet<string> = new Set([
  "disabled",
  "not_configured",
  "cap",
  "job_cap",
  "too_expensive",
  "bad_request",
  "too_long",
]);
const BUDGET_ERRORS: ReadonlySet<string> = new Set(["cap", "job_cap", "too_expensive"]);

export async function runChildCheck(input: ChildInput, deps: ChildDeps): Promise<ChildOutcome> {
  const l = input.limits;
  const budget = new TurnBudget(
    {
      maxToolSteps: l.maxToolSteps,
      maxModelCalls: l.maxCallsPerDriver,
      maxTurnCents: l.driverCents,
      wallClockMs: Math.max(0, Math.min(l.childTimeoutMs, input.deadlineAt - input.startedAt)),
      summaryChars: 1,
    },
    input.startedAt,
    deps.clock,
  );
  const read = new Set<string>();
  let costKnown = true;
  let stepCount = 0;

  const end = (status: CheckStatus, answer: ValidCheck | null = null, dropped = 0): ChildOutcome => ({
    status,
    answer,
    costNanocents: budget.costNanocents,
    costKnown,
    modelCalls: budget.modelCalls,
    toolSteps: budget.toolSteps,
    stepCount,
    droppedSources: dropped,
  });

  const ctx = (): GatewayContext => ({
    session: input.session,
    role: "operator",
    model: "spark",
    turnId: input.turnId,
    traceId: input.traceId,
    now: new Date(deps.clock()),
    deadlineAt: budget.deadlineAt,
    timeZone: input.timeZone,
  });

  // Too few tool steps for every read, or no model call: the check could not see the whole week,
  // so it ends before reading anything.
  if (l.maxToolSteps < CHECK_READS.length || l.maxCallsPerDriver < 1) return end("error");
  if (!deps.switchOn()) return end("error");

  // The reads, one after another: each step takes the turn's next seq, so two at once would
  // collide. Any read the gateway does not allow ends the check with no model call.
  const records: Record<string, Record<string, unknown>> = {};
  for (const r of CHECK_READS) {
    const cap = budget.beforeToolStep();
    if (cap === "clock") return end("timed_out");
    if (cap !== null) return end("error");
    const s = await deps.steps.startStep(input.turnId, {
      kind: "tool",
      label: toolNamed(r.tool)?.label ?? "Reading the driver's records",
    });
    stepCount += 1;
    budget.addToolStep();
    let outcome: GatewayOutcome;
    try {
      outcome = await deps.callTool(ctx(), {
        id: `check-${r.key}`,
        name: r.tool,
        argumentsJson: JSON.stringify(r.args(input.driverId, input.week)),
      });
    } catch {
      outcome = {
        decision: "failed",
        decisionId: "",
        tool: r.tool,
        reason: "tool_failed",
        result: { error: "tool_failed" },
        latencyMs: 0,
      };
    }
    const allowed = outcome.decision === "allowed";
    if (allowed) {
      for (const src of sourcesFrom(outcome.tool, outcome.result)) read.add(recordKey(src.table, src.id));
    }
    await deps.steps.finishStep(input.turnId, s.id, {
      state: allowed ? "done" : "failed",
      gatewayDecisionId: outcome.decisionId || null,
      detail: { tool: r.tool, decision: outcome.decision, reason: outcome.reason },
    });
    if (!allowed) return end("error");
    records[r.key] = outcome.result;
  }

  if (!deps.switchOn()) return end("error");
  const cap = budget.beforeModelCall();
  if (cap === "cents") return end("budget");
  if (cap === "clock") return end("timed_out");
  if (cap !== null) return end("error");
  const remaining = budget.remainingMs() - CALL_MARGIN_MS;
  if (remaining < MIN_CALL_MS) return end("timed_out");
  const callCap = Math.min(l.callCents, budget.centsLeft());
  if (callCap < 1) return end("budget");

  const messages: AiMessage[] = [
    { role: "system", content: CHECK_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        driverId: input.driverId,
        week: input.week,
        focus: input.focus,
        brief: input.brief ?? "",
        records,
      }),
    },
  ];
  const step = await deps.steps.startStep(input.turnId, { kind: "model", label: "Thinking it through" });
  stepCount += 1;
  let result: AiResult;
  try {
    // No tools: the records are in the message, so the answer is the call's text.
    result = await deps.complete(
      "spark",
      {
        purpose: "fanout_check",
        messages,
        reasoningEffort: "low",
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxCostCents: callCap,
        timeoutMs: Math.min(MAX_CALL_MS, Math.floor(remaining)),
        traceId: input.traceId,
      },
      input.session,
    );
  } catch (err) {
    const category = err instanceof AiError ? err.category : "unknown";
    const status = err instanceof AiError ? err.httpStatus : undefined;
    // A refusal before sending, or a definite provider refusal (401, 402, 429), cost nothing.
    if (!REFUSED_BEFORE_SENDING.has(category) && !refusedByProvider(category, status)) costKnown = false;
    await deps.steps.finishStep(input.turnId, step.id, { state: "failed", detail: { category } });
    if (category === "timeout") return end("timed_out");
    if (BUDGET_ERRORS.has(category)) return end("budget");
    return end("error");
  }
  budget.addModelCall(result.costNanocents);
  await deps.steps.finishStep(input.turnId, step.id, {
    state: "done",
    modelCallId: result.callId,
    detail: { status: result.status, toolCalls: result.toolCalls.length, textChars: result.text.length },
  });
  // A call offered no tools that still answers with a tool call has no answer to check.
  if (result.toolCalls.length > 0) return end("unparsed");
  const checked = validateCheck(result.text, input.driverId, read);
  if (!checked) return end("unparsed");
  return end("done", checked.answer, checked.dropped);
}
