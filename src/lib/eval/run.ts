import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { runAudit } from "../agent/auditor/run";
import { callTool, toolsFor } from "../agent/gateway";
import { dbTurnStore, openAgentTurn } from "../agent/gateway/store";
import type { OpenedTurn } from "../agent/gateway/store/types";
import type { CompleteFn } from "../agent/gateway/types";
import { ESCALATION_CALL, LOOP_TEXT, OPERATOR_CALL, operatorPrompt } from "../agent/policy";
import { runTurn, turnRequest, type TurnDeps, type TurnOutcome } from "../agent/operator/turn";
import type { AiMessage, AiRequest, AiTextTarget } from "../ai";
import type { Session } from "../auth/claims";
import type { Queryable, TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { cachedRun, cacheKey } from "./cache";
import { scoreCase, type InjectionRead, type ProposalRead, type TurnRead } from "./score";
import type { Arm, CaseResult, CaseScore, EvalCase, SourceRef } from "./types";

// One case through the real operator turn (design 4.5): a fresh conversation, the product's
// tools, gateway, turn store and second check, with the operator's Muse Spark calls sent where
// the arm says. Then the turn's proposals, model calls and (for an injection case) its screening
// and advance decisions are read back from the tables and scored. Nothing here moves money: the
// proposals stay proposed, and the pay correction executor's switch is never touched.

// The arm's operator calls. spark is the product as shipped. wonder and spark_open send the
// operator's Muse Spark calls to that model instead, in the plain shape every host takes (no tool
// search, no prompt cache, no input-placed system message, no tool search items); the escalation
// and the second check already call Muse Wonder and are left as they are. On wonder the per-call
// cap rises from the operator's to the escalation's, Wonder's own ceiling for an operator call.
export function armComplete(arm: Arm, base: CompleteFn): CompleteFn {
  if (arm === "spark") return base;
  const to: AiTextTarget = arm;
  return (target, request, session) => {
    if (target !== "spark") return base(target, request, session);
    return base(to, plainRequest(to, request), session);
  };
}

function plainMessage(m: AiMessage): AiMessage {
  if (m.role === "system") return { role: "system", content: m.content };
  if (m.role === "assistant") {
    return m.toolCalls ? { role: "assistant", content: m.content, toolCalls: m.toolCalls } : { role: "assistant", content: m.content };
  }
  return m;
}

export function plainRequest(to: AiTextTarget, request: AiRequest): AiRequest {
  const plain: AiRequest = { ...request, messages: request.messages.map(plainMessage) };
  delete plain.toolSearch;
  delete plain.cache;
  delete plain.replay;
  if (request.tools) plain.tools = request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  // Reasoning items replay only on Meta's API; Baseten's answers carry none.
  const reasoning = (request.replay ?? []).filter((item) => item.type === "reasoning");
  if (to === "wonder" && reasoning.length > 0) plain.replay = reasoning;
  if (to === "wonder" && request.maxCostCents === OPERATOR_CALL.maxCostCents) {
    plain.maxCostCents = ESCALATION_CALL.maxCostCents;
  }
  return plain;
}

// The eval's clock: the seed's anchor day at 16:00 UTC (the demo's open week, a weekday
// afternoon on both carriers), moving forward with real time so the turn's own clock caps work.
export function evalClock(anchor: string, realNow: () => number = Date.now): () => number {
  const start = Date.parse(`${anchor}T16:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error("the eval anchor is not a date");
  const began = realNow();
  return () => start + (realNow() - began);
}

export type CaseDeps = {
  arm: Arm;
  session: Session;
  db: TenantDb;
  // The model call every model call of the case goes through (the wrapper's complete in a run, a
  // fake in the tests). The arm's redirect is applied on top of it.
  complete: CompleteFn;
  clock: () => number;
  // The second check on one proposal. Default: the product's runAudit with this db and complete.
  audit?: (session: Session, proposalId: string) => Promise<unknown>;
  newId?: () => string;
};

// The operator's tools and request options for the arm: the product's for spark; for the
// redirected arms the tools unflagged for search and the plain request.
export function armTools(arm: Arm): TurnDeps["tools"] {
  return toolsFor("operator", { defer: arm === "spark" ? flags.agentToolSearch : false });
}

export function armRequest(arm: Arm, tools: TurnDeps["tools"]): NonNullable<TurnDeps["request"]> {
  return arm === "spark" ? turnRequest(tools, flags.agentToolSearch, flags.agentPromptCache) : { toolSearch: false, cache: null };
}

// The product's turn deps (defaultTurnDeps), with this case's database, clock and model call.
export function evalTurnDeps(deps: CaseDeps): TurnDeps {
  const { arm, session, db, clock } = deps;
  const tools = armTools(arm);
  const gateway = { db, clock, complete: deps.complete };
  return {
    complete: armComplete(arm, deps.complete),
    callTool: (ctx, call) => callTool(ctx, call, gateway),
    store: dbTurnStore(session, { db, clock: () => new Date(clock()) }),
    tools,
    clock,
    limits: { ...flags.agentTurnLimits, maxTurns: flags.runLimits.maxTurns },
    request: armRequest(arm, tools),
  };
}

function inTenant<T>(db: TenantDb, session: Session, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

type ProposalRow = {
  id: string;
  kind: string;
  amount_cents: string | number;
  direction: "in" | "out" | "none";
  sources: unknown;
  flagged_input_id: string | null;
  status: string;
  auditor_verdict: string | null;
  auditor_agrees: boolean | null;
  auditor_trace_id: string | null;
};

const PROPOSALS_SQL =
  "SELECT CAST(id AS text) AS id, kind, amount_cents, direction, sources," +
  " CAST(flagged_input_id AS text) AS flagged_input_id, status, auditor_verdict, auditor_agrees," +
  " CAST(auditor_trace_id AS text) AS auditor_trace_id" +
  " FROM proposals WHERE tenant_id = current_tenant_id() AND turn_id = CAST($1 AS uuid) ORDER BY id";

const CALLS_SQL =
  "SELECT COALESCE(SUM(cost_nanocents), 0) AS cost, COALESCE(SUM(duration_ms), 0) AS ms FROM model_calls" +
  " WHERE tenant_id = current_tenant_id() AND trace_id = ANY(CAST($1 AS uuid[]))";

const SCREEN_SQL =
  "SELECT verdict, via, categories FROM screenings WHERE tenant_id = current_tenant_id()" +
  " AND input_id = CAST($1 AS uuid) ORDER BY created_at DESC, id LIMIT 1";

const ADVANCE_DECISIONS_SQL =
  "SELECT decision, limit_cents, requested_cents FROM gateway_decisions WHERE tenant_id = current_tenant_id()" +
  " AND trace_id = $1 AND tool = 'propose_advance'";

// A count read back as a whole number; anything else is not known and fails the read.
function whole(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("a stored amount is not a whole number");
  return n;
}

function refsOf(v: unknown): SourceRef[] {
  const list = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  if (!Array.isArray(list)) return [];
  return list.flatMap((r) => {
    const o = r as Record<string, unknown> | null;
    return o && typeof o.table === "string" && typeof o.id === "string" ? [{ table: o.table, id: o.id }] : [];
  });
}

function categoriesOf(v: unknown): string[] {
  const list = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === "string") : [];
}

async function readProposals(db: TenantDb, session: Session, turnId: string): Promise<ProposalRow[]> {
  return inTenant(db, session, (q) => q.query<ProposalRow>(PROPOSALS_SQL, [turnId]));
}

async function sumCalls(q: Queryable, traceIds: readonly string[]): Promise<{ cost: number; ms: number }> {
  if (traceIds.length === 0) return { cost: 0, ms: 0 };
  const [row] = await q.query<{ cost: string | number; ms: string | number }>(CALLS_SQL, [`{${traceIds.join(",")}}`]);
  return { cost: whole(row?.cost ?? 0), ms: whole(row?.ms ?? 0) };
}

async function readInjection(q: Queryable, c: EvalCase, traceId: string): Promise<InjectionRead | null> {
  if (!c.injection) return null;
  const [screen] = await q.query<{ verdict: "clean" | "flagged"; via: string; categories: unknown }>(SCREEN_SQL, [c.injection.inputId]);
  let limitHeld: boolean | null = null;
  if (c.injection.limit) {
    const rows = await q.query<{ decision: string; limit_cents: string | number | null; requested_cents: string | number | null }>(
      ADVANCE_DECISIONS_SQL,
      [traceId],
    );
    // Every advance the gateway let through stayed within the limit it read (vacuously so when
    // the turn asked for none); a blocked one is the limit holding.
    limitHeld = rows.every(
      (r) =>
        r.decision !== "allowed" ||
        (r.limit_cents !== null && r.requested_cents !== null && Number(r.requested_cents) <= Number(r.limit_cents)),
    );
  }
  return {
    screen: screen ? { verdict: screen.verdict, via: screen.via, categories: categoriesOf(screen.categories) } : null,
    limitHeld,
  };
}

// What the turn left in the tables, read in one tenant transaction.
export async function readTurn(
  db: TenantDb,
  session: Session,
  c: EvalCase,
  turn: Pick<OpenedTurn, "turnId" | "traceId">,
): Promise<Pick<TurnRead, "proposals" | "injection" | "costNanocents" | "auditorNanocents" | "latencyMs">> {
  return inTenant(db, session, async (q) => {
    const rows = await q.query<ProposalRow>(PROPOSALS_SQL, [turn.turnId]);
    const proposals: ProposalRead[] = rows.map((p) => ({
      kind: p.kind,
      amountCents: whole(p.amount_cents),
      direction: p.direction,
      sources: refsOf(p.sources),
      flaggedInputId: p.flagged_input_id,
      status: p.status,
      auditorVerdict: p.auditor_verdict,
      auditorAgrees: p.auditor_agrees,
    }));
    const operator = await sumCalls(q, [turn.traceId]);
    const auditTraces = [...new Set(rows.flatMap((p) => (p.auditor_trace_id ? [p.auditor_trace_id] : [])))];
    const auditor = await sumCalls(q, auditTraces);
    return {
      proposals,
      injection: await readInjection(q, c, turn.traceId),
      costNanocents: operator.cost,
      auditorNanocents: auditor.cost,
      latencyMs: operator.ms,
    };
  });
}

const NO_SIGNALS = {
  causeRight: null,
  amountRight: null,
  fixRight: null,
  pass: null,
  operatorRight: null,
  proposalKinds: [],
  auditorVerdict: null,
  auditorAgrees: null,
  injection: null,
  costNanocents: 0,
  auditorNanocents: 0,
  latencyMs: 0,
} as const;

export const notRunScore = (): CaseScore => ({ status: "not_run", ...NO_SIGNALS, proposalKinds: [] });
export const unknownScore = (): CaseScore => ({ status: "unknown", ...NO_SIGNALS, proposalKinds: [] });
export const overCapScore = (): CaseScore => ({ status: "over_cap", ...NO_SIGNALS, proposalKinds: [] });

// A turn that threw, closed as failed so it does not stay running (as the Inbox hand-off does).
async function closeFailed(deps: CaseDeps, turnId: string): Promise<void> {
  try {
    await dbTurnStore(deps.session, { db: deps.db, clock: () => new Date(deps.clock()) }).finishTurn(turnId, {
      status: "failed",
      endedReason: "store",
      text: LOOP_TEXT.failed,
      summary: "",
      stepCount: 0,
      modelCallCount: 0,
      costNanocents: 0,
    });
  } catch {
    console.error("eval: a failed turn could not be closed");
  }
}

export async function runCase(c: EvalCase, deps: CaseDeps): Promise<CaseScore> {
  if (c.skip !== null) return notRunScore();
  const newId = deps.newId ?? randomUUID;
  const startedAt = deps.clock();
  const opened = await openAgentTurn(
    deps.session,
    {
      conversationId: null,
      turnId: newId(),
      text: c.prompt,
      now: new Date(startedAt),
      summaryChars: flags.agentTurnLimits.summaryChars,
      readNotes: true,
    },
    { db: deps.db, clock: () => new Date(deps.clock()) },
  );
  if ("refused" in opened) return unknownScore();

  let outcome: TurnOutcome | null = null;
  try {
    outcome = await runTurn({ session: deps.session, turn: opened, text: c.prompt, startedAt }, evalTurnDeps(deps));
  } catch (err) {
    console.error(`eval: case ${c.key} turn failed: ${err instanceof Error ? err.name : "unknown"}`);
    await closeFailed(deps, opened.turnId);
  }

  // The second check on each proposal, as the product runs it when a card is shown. A check that
  // fails leaves the verdict empty, which scores as no verdict.
  const audit =
    deps.audit ?? ((s: Session, id: string) => runAudit(s, id, { db: deps.db, complete: deps.complete, clock: () => new Date(deps.clock()) }));
  for (const p of await readProposals(deps.db, deps.session, opened.turnId)) {
    try {
      await audit(deps.session, p.id);
    } catch {
      console.error(`eval: case ${c.key} second check failed`);
    }
  }

  const read = await readTurn(deps.db, deps.session, c, opened);
  return scoreCase(c, {
    status: outcome ? outcome.status : "threw",
    endedReason: outcome ? outcome.endedReason : null,
    text: outcome ? outcome.text : "",
    ...read,
  });
}

// The arm's key inputs for every case: the operator's system prompt and tool names as offered.
export function armPromptOf(arm: Arm): { systemPrompt: string; toolNames: string[] } {
  const tools = armTools(arm);
  const toolNames = tools.map((t) => t.name);
  return { systemPrompt: operatorPrompt(toolNames, armRequest(arm, tools).toolSearch), toolNames };
}

export type ArmRun = {
  arm: Arm;
  cases: readonly EvalCase[];
  // Each carrier's staff session, by slug.
  sessions: Readonly<Record<string, Session>>;
  deps: Omit<CaseDeps, "arm" | "session">;
  anchor: string;
  modelId: string | null;
  auditorModelId: string | null;
  cacheDir: string;
  fresh: boolean;
  // Runs one case; the default is runCase. The tests pass their own.
  run?: (c: EvalCase, deps: CaseDeps) => Promise<CaseScore>;
};

// Every case of one arm, in order, each through the cache. Once a case is cut by the run's spend
// stop, the cases after it are not started and count as over the cap.
export async function runArm(a: ArmRun): Promise<{ results: CaseResult[]; stoppedAtCap: boolean }> {
  const { systemPrompt, toolNames } = armPromptOf(a.arm);
  const run = a.run ?? runCase;
  const results: CaseResult[] = [];
  const push = (c: EvalCase, score: CaseScore, cached = false) =>
    results.push({ arm: a.arm, caseKey: c.key, kind: c.kind, cached, score });
  let stoppedAtCap = false;
  for (const c of a.cases) {
    if (c.skip !== null) {
      push(c, notRunScore());
      continue;
    }
    if (stoppedAtCap) {
      push(c, overCapScore());
      continue;
    }
    const session = a.sessions[c.carrierSlug];
    if (!session) {
      console.error(`eval: no session for ${c.carrierSlug}`);
      push(c, unknownScore());
      continue;
    }
    const key = cacheKey({
      arm: a.arm,
      modelId: a.modelId,
      auditorModelId: a.auditorModelId,
      caseKey: c.key,
      prompt: c.prompt,
      systemPrompt,
      anchor: a.anchor,
      toolNames,
    });
    let out: { score: CaseScore; cached: boolean };
    try {
      out = await cachedRun(a.cacheDir, key, a.fresh, () => run(c, { ...a.deps, arm: a.arm, session }));
    } catch (err) {
      // A case that could not be run or read back is not known; the next one still runs.
      console.error(`eval: case ${c.key} could not be scored: ${err instanceof Error ? err.name : "unknown"}`);
      out = { score: unknownScore(), cached: false };
    }
    if (out.score.status === "over_cap") stoppedAtCap = true;
    push(c, out.score, out.cached);
  }
  return { results, stoppedAtCap };
}
