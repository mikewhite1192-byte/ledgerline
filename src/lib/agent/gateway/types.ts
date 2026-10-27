import type { z } from "zod";
import type { AiResult, AiTextTarget, AiRequest } from "../../ai";
import type { Session } from "../../auth/claims";
import type { Queryable, TenantDb } from "../../db";
import { TABLES, type Cents, type TableName } from "../../rules-engine";

// The gateway's shared types. Every tool a model can call is a ToolDef in the registry; the loop
// reaches tools only through callTool() in index.ts.

export const AGENT_ROLES = ["operator", "auditor", "triage"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

// Nothing else can be registered: there is no tier that moves money.
export const TIERS = ["read", "propose", "record"] as const;
export type Tier = (typeof TIERS)[number];

export type AgentModel = "spark" | "wonder" | "spark_open";

export const REASON_CATEGORIES = [
  "ok",
  "duplicate",
  "role_not_allowed",
  "unknown_tool",
  "invalid_args",
  "unknown_record",
  "amount_over_limit",
  "engine_refused",
  "limit_unavailable",
  "screen_flagged",
  "screen_error",
  "result_truncated",
  "tool_failed",
  "budget",
  // The tool sits behind a release switch that is off (flags.ts): it is neither offered nor run.
  "disabled",
  // A proposal exception, never a decision reason: the advance was cut to what the engine allows
  // after a larger ask in the same trace was refused (design 4.2).
  "capped_to_eligible",
  // A proposal exception: the advance names a card that is not one of the driver's active cards.
  "card_not_drivers",
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

// Names held for tools that later items register. A reserved name is not in the registry, so a
// call to it is unknown_tool until the item that owns it lands. get_proposal, the auditor's
// evidence read, was reserved here until AUDITOR registered it. tool_search is the model API's
// own search tool and is never registered: a function call by that name is unknown_tool.
export const RESERVED_TOOL_NAMES = ["create_case", "tool_search"] as const;

// The tables a tool's ids may point at: the engine's tables plus the outside text. A citation in
// the operator's answer may name only these.
export const GATEWAY_TABLES = [...TABLES, "untrusted_inputs"] as const;
export type GatewayTable = TableName | "untrusted_inputs";
// The tables an argument's id may name: the above plus proposals, which only the auditor's
// get_proposal reads.
export const REF_TABLES = [...GATEWAY_TABLES, "proposals"] as const;
export type RefTable = GatewayTable | "proposals";
export type GatewayRef = { table: RefTable; id: string };

export type LimitResult =
  | {
      ok: true;
      limitCents: Cents;
      requestedCents: Cents;
      exceptions: ReasonCategory[];
      reasons: string[];
      sources: GatewayRef[];
    }
  | {
      ok: false;
      reason: "amount_over_limit" | "engine_refused" | "limit_unavailable" | "budget";
      limitCents: Cents | null;
      requestedCents: Cents | null;
    };

export type GatewayContext = {
  session: Session;
  role: AgentRole;
  model: AgentModel;
  turnId: string | null;
  traceId: string;
  // The clock for this call, injected so tests never read the wall clock.
  now: Date;
  // Epoch milliseconds after which nothing new starts.
  deadlineAt: number;
  // The tenant's IANA zone; dates in tool args are read in it.
  timeZone: string;
};

// A model call, as the screener needs it. The default is complete() from src/lib/ai.
export type CompleteFn = (
  target: AiTextTarget,
  request: AiRequest,
  session: Session,
) => Promise<AiResult>;

export type GatewayDeps = {
  db?: TenantDb;
  complete?: CompleteFn;
  // Milliseconds since the epoch, for latency only. Default Date.now.
  clock?: () => number;
};

export type ScreenCategory =
  | "instruction_to_agent"
  | "authority_claim"
  | "urgency_pressure"
  | "amount_or_payee_change"
  | "data_exfiltration"
  | "off_policy_request"
  | "pattern_match"
  | "parse_failed"
  | "screen_error";

export type ScreenVerdict = {
  inputId: string;
  verdict: "clean" | "flagged";
  categories: ScreenCategory[];
  confidence: number | null;
  contentHash: string;
  via: "model" | "cache" | "pattern" | "error";
  modelCallId: string | null;
  screenerVersion: 1;
};

// What a tool's run receives beyond its args: the screen verdict (for a tool that screens) and
// the limit result (for a propose tool).
export type RunExtras = {
  screen: ScreenVerdict | null;
  limit: Extract<LimitResult, { ok: true }> | null;
};

// The one list of proposal kinds. src/lib/proposals/execute.ts imports it from here (the ledger
// side may import the agent tree; the reverse is what the import-boundary test forbids). The
// database CHECK carries this list plus kinds that later items add (0013, 0015, 0022).
export const PROPOSAL_KINDS = [
  "advance_payout",
  "pay_correction",
  "invoice_fix",
  "load_rate_fill",
  "invoice_post",
  "payment_reapply",
  "detention_charge",
  "settlement_approve",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

// What a propose tool hands the loop. The loop persists it (AGENT-CORE); a person approves it.
export type ProposalDraft = {
  kind: ProposalKind;
  subjectTable: GatewayTable;
  subjectId: string;
  amountCents: Cents;
  args: Record<string, unknown>;
  limitCents: Cents;
  exceptions: ReasonCategory[];
  reasons: string[];
  sources: GatewayRef[];
};

export type ToolResult = { result: Record<string, unknown>; draft?: ProposalDraft };

export interface ToolDef<A> {
  name: string;
  // Model-facing, fixed text.
  description: string;
  tier: Tier;
  roles: readonly AgentRole[];
  // The step label the chat shows: fixed text, never model output.
  label: string;
  // tenantId is never a field; strict objects reject it as an unknown key.
  args: z.ZodType<A>;
  // Every id the args name, with its table.
  refs: (args: A) => GatewayRef[];
  limit?: (q: Queryable, ctx: GatewayContext, args: A) => Promise<LimitResult>;
  // The untrusted input this call shows a model; the gateway screens it before run.
  screens?: (args: A) => string;
  // A tool behind a release switch: read on every offer and every call. False means the tool is
  // not offered to any role and a call to it is blocked as disabled before its args are read.
  // The tool's own limit and run check the same switch again.
  enabled?: () => boolean;
  run: (q: Queryable, ctx: GatewayContext, args: A, extras: RunExtras) => Promise<ToolResult>;
}

// A registered tool with its argument type erased: args are checked by its own schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

export function defineTool<A>(def: ToolDef<A>): AnyToolDef {
  return def;
}

export type FieldError = { path: string; code: string };

export type GatewayOutcome =
  | {
      decision: "allowed";
      decisionId: string;
      tool: string;
      tier: Tier;
      reason: ReasonCategory;
      result: Record<string, unknown>;
      refs: GatewayRef[];
      draft?: ProposalDraft;
      flaggedInputId?: string;
      latencyMs: number;
    }
  | {
      decision: "blocked" | "invalid_args" | "denied" | "unknown_tool" | "failed";
      decisionId: string;
      tool: string;
      reason: ReasonCategory;
      // What the model is told: never raw argument text or upstream errors.
      result: Record<string, unknown>;
      fieldErrors?: FieldError[];
      limitCents?: Cents;
      latencyMs: number;
    };

export type ToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
  // The wrapper call that issued this tool call, when the loop knows it.
  modelCallId?: string | null;
};
