import { randomUUID } from "node:crypto";
import { getDb, type Queryable, type TenantDb } from "../../db";
import type { Cents } from "../../rules-engine";
import { assertMembership } from "../../tenant/context";
import { isUuid } from "../../uuid";
import { logDecision, type DecisionRow } from "./decisions";
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
// a decision that cannot be recorded is not allowed.

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

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "error";
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
  const row: DecisionRow = {
    id: decisionId,
    turnId: ctx.turnId,
    traceId: ctx.traceId,
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
    outcome = await dispatch(ctx, call, deps, db, row, decisionId, clock);
  } catch (err) {
    console.error(`gateway: ${row.tool} failed (${errorText(err)})`);
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
    console.error(`gateway: the decision for ${row.tool} was not recorded (${errorText(err)})`);
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
