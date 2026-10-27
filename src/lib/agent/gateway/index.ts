import { randomUUID } from "node:crypto";
import { getDb, type Queryable, type TenantDb } from "../../db";
import type { Cents } from "../../rules-engine";
import { assertMembership } from "../../tenant/context";
import { isUuid } from "../../uuid";
import { INVALID_TRACE, isTraceId, logDecision, type DecisionRow } from "./decisions";
import { redactArgs } from "./redact";
import { assertRefsExist, distinctRefs } from "./refs";
import { REDACT_ENUMS, TOOL_NAME, toolNamed } from "./registry";
import { screenUntrustedInput } from "./screen";
import type {
  GatewayContext,
  GatewayDeps,
  FieldError,
  GatewayOutcome,
  LimitResult,
  ScreenVerdict,
  ToolCall,
  ToolResult,
} from "./types";
import { parseArgs } from "./validate";

// The one gate between a model and the carrier's records (design section 3). Every tool call
// takes the same path, in the same order, and fails closed:
//   1. unknown_tool   the name is not in the registry
//   2. denied         the caller's role may not use the tool
//   3. invalid_args   the args fail the tool's strict schema (paths and codes only)
//   4. unknown_record an id in the args is not a row of the caller's tenant
//   5. blocked        a propose tool's amount is over the limit the rules engine sets
//   6. blocked        the outside text a tool shows could not be screened
//   7. failed         the tool threw or ran out of time (raw error to the server log only)
//   8. allowed        the result, cut to 8,000 characters
// One decision row is written for every call. A call whose decision cannot be written is failed:
// a decision that cannot be recorded is not allowed. The trace id is checked once, on the way in:
// a call whose trace id the log cannot hold is failed after step 2, before its args are read, and
// recorded under INVALID_TRACE. Every later step, the limit lookups included, reads the checked id.

export { toolsFor, TOOL_REGISTRY } from "./registry";
export { screenUntrustedInput } from "./screen";
export type {
  AgentRole,
  GatewayContext,
  GatewayDeps,
  GatewayOutcome,
  ProposalDraft,
  ScreenVerdict,
  ToolCall,
} from "./types";

export const RUN_TIMEOUT_MS = 6_000;
export const MAX_RESULT_CHARS = 8_000;

class GatewayTimeout extends Error {
  constructor() {
    super("gateway step timed out");
    this.name = "GatewayTimeout";
  }
}

class InvalidTraceId extends Error {
  constructor() {
    super("the trace id is not one the decision log can hold");
    this.name = "InvalidTraceId";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GatewayTimeout()), Math.max(0, ms));
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// The result cut to fit: a long rows list loses rows from the end and says so.
export function capResult(result: Record<string, unknown>): {
  result: Record<string, unknown>;
  chars: number;
  truncated: boolean;
} {
  const whole = JSON.stringify(result);
  if (whole.length <= MAX_RESULT_CHARS) return { result, chars: whole.length, truncated: false };
  const rows = Array.isArray(result.rows) ? (result.rows as unknown[]) : null;
  if (rows) {
    const cut = (n: number) => ({
      ...result,
      rows: rows.slice(0, n),
      truncated: true,
      rowsShown: n,
      rowsTotal: rows.length,
    });
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (JSON.stringify(cut(mid)).length <= MAX_RESULT_CHARS) lo = mid;
      else hi = mid - 1;
    }
    const out = cut(lo);
    const text = JSON.stringify(out);
    if (text.length <= MAX_RESULT_CHARS) return { result: out, chars: text.length, truncated: true };
  }
  const out = { truncated: true, note: "The result was too large to return. Narrow the request." };
  return { result: out, chars: JSON.stringify(out).length, truncated: true };
}

// What the server log keeps of an error: its name, its category when it has one (a DbError's
// rls_denied, an AiError's timeout) and its short code (a SQLSTATE such as 23514, or a system code
// such as ECONNRESET). Never the message: the driver, the Data API, the engine or a tool can put
// row values in it.
const ERROR_NAME = /^[A-Za-z][\w.]{0,63}$/;
const ERROR_CATEGORY = /^[a-z_]{1,32}$/;
const ERROR_CODE = /^[A-Z0-9_]{1,32}$/;
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return "error";
  const e = err as { category?: unknown; sqlState?: unknown; code?: unknown };
  const parts = [ERROR_NAME.test(err.name) ? err.name : "Error"];
  if (typeof e.category === "string" && ERROR_CATEGORY.test(e.category)) parts.push(e.category);
  const code = e.sqlState ?? e.code;
  if (typeof code === "string" && ERROR_CODE.test(code)) parts.push(code);
  return parts.join(" ");
}

// The ids that tie a server log line to its call, so a call whose decision row could not be
// written (a dead pool) can still be traced. Ids only: never args, personal data or model text.
function callIds(decisionId: string, traceId: string): string {
  return `decision=${decisionId} trace=${traceId}`;
}

async function inTenant<T>(
  db: TenantDb,
  ctx: GatewayContext,
  fn: (q: Queryable) => Promise<T>,
): Promise<T> {
  return db.withTenant(ctx.session.tenantId, async (q) => {
    await assertMembership(q, ctx.session);
    return fn(q);
  });
}

export async function callTool(
  ctx: GatewayContext,
  call: ToolCall,
  deps: GatewayDeps = {},
): Promise<GatewayOutcome> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const decisionId = randomUUID();
  const name = typeof call?.name === "string" ? call.name : "";
  // The one trace check: the row, the log lines and every step of dispatch use this value.
  const traceId = isTraceId(ctx.traceId) ? ctx.traceId : INVALID_TRACE;
  const checked: GatewayContext = { ...ctx, traceId };
  const row: DecisionRow = {
    id: decisionId,
    turnId: ctx.turnId,
    traceId,
    role: ctx.role,
    model: ctx.model,
    tool: TOOL_NAME.test(name) ? name : "invalid_name",
    tier: null,
    argsRedacted: {},
    refs: [],
    decision: "failed",
    reason: "tool_failed",
    limitCents: null,
    requestedCents: null,
    resultChars: null,
    modelCallId: isUuid(call?.modelCallId) ? call.modelCallId : null,
    latencyMs: 0,
  };
  let outcome: GatewayOutcome;
  let db: TenantDb | null = null;
  try {
    db = deps.db ?? getDb();
    outcome = await dispatch(checked, call, deps, db, row, decisionId, clock);
  } catch (err) {
    console.error(`gateway: ${row.tool} failed, ${callIds(decisionId, traceId)} (${errorText(err)})`);
    row.decision = "failed";
    row.reason = "tool_failed";
    row.resultChars = null;
    outcome = {
      decision: "failed",
      decisionId,
      tool: row.tool,
      reason: "tool_failed",
      result: { error: "tool_failed" },
      latencyMs: 0,
    };
  }
  row.latencyMs = clock() - started;
  outcome.latencyMs = row.latencyMs;
  try {
    if (!db) throw new Error("no database");
    await logDecision(db, ctx.session, row);
  } catch (err) {
    console.error(
      `gateway: the decision for ${row.tool} was not recorded, ${callIds(decisionId, traceId)} (${errorText(err)})`,
    );
    return {
      decision: "failed",
      decisionId,
      tool: row.tool,
      reason: "tool_failed",
      result: { error: "tool_failed" },
      latencyMs: row.latencyMs,
    };
  }
  return outcome;
}

async function dispatch(
  ctx: GatewayContext,
  call: ToolCall,
  deps: GatewayDeps,
  db: TenantDb,
  row: DecisionRow,
  decisionId: string,
  clock: () => number,
): Promise<GatewayOutcome> {
  const refuse = (
    decision: "blocked" | "invalid_args" | "denied" | "unknown_tool",
    reason: GatewayOutcome["reason"],
    result: Record<string, unknown>,
    extra: { fieldErrors?: FieldError[]; limitCents?: Cents } = {},
  ): GatewayOutcome => {
    row.decision = decision;
    row.reason = reason;
    return { decision, decisionId, tool: row.tool, reason, result, latencyMs: 0, ...extra };
  };

  // 1 and 2: the name, then the role. No database read.
  const tool = TOOL_NAME.test(row.tool) ? toolNamed(row.tool) : null;
  if (!tool) return refuse("unknown_tool", "unknown_tool", { error: "unknown_tool" });
  row.tier = tool.tier;
  if (!tool.roles.includes(ctx.role)) {
    return refuse("denied", "role_not_allowed", { error: "role_not_allowed" });
  }
  // A trace id the log cannot hold (checked in callTool) fails the call here: no limit lookup,
  // screen or tool runs on it.
  if (ctx.traceId === INVALID_TRACE) throw new InvalidTraceId();

  // 3: strict args. A failure reports field paths and codes, never the text.
  const parsed = parseArgs(tool.args, call.argumentsJson);
  if (!parsed.ok) {
    row.argsRedacted = { fieldErrors: parsed.fieldErrors };
    return refuse(
      "invalid_args",
      "invalid_args",
      { error: "invalid_args", fieldErrors: parsed.fieldErrors },
      { fieldErrors: parsed.fieldErrors },
    );
  }
  const args = parsed.args;
  row.argsRedacted = redactArgs(args, REDACT_ENUMS);
  const refs = distinctRefs(tool.refs(args));
  row.refs = refs;

  const remaining = () => Math.min(RUN_TIMEOUT_MS, ctx.deadlineAt - clock());
  if (remaining() <= 0) throw new GatewayTimeout();

  // 4 and 5: the ids, then the limit, in the caller's tenant.
  const checked = await withTimeout(
    inTenant(db, ctx, async (q) => {
      if (!(await assertRefsExist(q, refs))) return { kind: "unknown_record" as const };
      if (tool.tier !== "propose") return { kind: "ok" as const, limit: null };
      if (!tool.limit) throw new Error("a propose tool has no limit");
      return { kind: "ok" as const, limit: await tool.limit(q, ctx, args) };
    }),
    remaining(),
  );
  if (checked.kind === "unknown_record") {
    return refuse("blocked", "unknown_record", { blocked: true, reason: "unknown_record" });
  }
  const limit: LimitResult | null = checked.limit;
  if (limit) {
    row.limitCents = limit.limitCents;
    row.requestedCents = limit.requestedCents;
    if (!limit.ok) {
      return refuse(
        "blocked",
        limit.reason,
        { blocked: true, reason: limit.reason, limitCents: limit.limitCents },
        limit.limitCents === null ? {} : { limitCents: limit.limitCents },
      );
    }
  }

  // 6: outside text is screened before any tool shows it.
  let screen: ScreenVerdict | null = null;
  if (tool.screens) {
    const screened = await screenUntrustedInput(ctx, tool.screens(args), deps);
    if (screened.decision === "blocked") {
      return refuse("blocked", screened.reason, { blocked: true, reason: screened.reason });
    }
    screen = screened.verdict;
  }

  // 7: run, in the caller's tenant, inside the time left.
  if (remaining() <= 0) throw new GatewayTimeout();
  const ran: ToolResult = await withTimeout(
    inTenant(db, ctx, (q) =>
      tool.run(q, ctx, args, { screen, limit: limit && limit.ok ? limit : null }),
    ),
    remaining(),
  );

  // 8: the size cap.
  const capped = capResult(ran.result);
  const flagged = screen?.verdict === "flagged";
  row.decision = "allowed";
  row.reason = flagged ? "screen_flagged" : capped.truncated ? "result_truncated" : "ok";
  row.resultChars = capped.chars;
  return {
    decision: "allowed",
    decisionId,
    tool: tool.name,
    tier: tool.tier,
    reason: row.reason,
    result: capped.result,
    refs,
    ...(ran.draft ? { draft: ran.draft } : {}),
    ...(flagged && screen ? { flaggedInputId: screen.inputId } : {}),
    latencyMs: 0,
  };
}
