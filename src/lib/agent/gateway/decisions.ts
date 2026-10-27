import type { Session } from "../../auth/claims";
import type { Queryable, TenantDb } from "../../db";
import { assertMembership } from "../../tenant/context";
import type { AgentModel, AgentRole, GatewayRef, ReasonCategory, Tier } from "./types";

// The decision log: one append-only row per tool call, whatever the outcome. The app role holds
// SELECT and INSERT on gateway_decisions and nothing else, so a written decision never changes.

export type DecisionKind = "allowed" | "blocked" | "invalid_args" | "denied" | "unknown_tool" | "failed";

export type DecisionRow = {
  id: string;
  turnId: string | null;
  traceId: string;
  role: AgentRole;
  model: AgentModel;
  tool: string;
  tier: Tier | null;
  argsRedacted: Record<string, unknown>;
  refs: GatewayRef[];
  decision: DecisionKind;
  reason: ReasonCategory;
  limitCents: number | null;
  requestedCents: number | null;
  resultChars: number | null;
  modelCallId: string | null;
  latencyMs: number;
};

const INSERT_SQL =
  "INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier," +
  " args_redacted, refs, decision, reason, limit_cents, requested_cents, result_chars," +
  " model_call_id, latency_ms) VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid)," +
  " $3, $4, $5, $6, $7, CAST($8 AS jsonb), CAST($9 AS jsonb), $10, $11, $12, $13, $14," +
  " CAST($15 AS uuid), $16)";

// A bigint cents column takes a safe integer only; anything else is stored as null.
function centsOrNull(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && Math.abs(value) < 1_000_000_000
    ? value
    : null;
}

export async function insertDecision(q: Queryable, row: DecisionRow): Promise<void> {
  const n = await q.execute(INSERT_SQL, [
    row.id,
    row.turnId,
    row.traceId,
    row.role,
    row.model,
    row.tool,
    row.tier,
    JSON.stringify(row.argsRedacted),
    JSON.stringify(row.refs),
    row.decision,
    row.reason,
    centsOrNull(row.limitCents === null ? null : Math.max(0, row.limitCents)),
    centsOrNull(row.requestedCents),
    row.resultChars,
    row.modelCallId,
    Math.max(0, Math.round(row.latencyMs)),
  ]);
  if (n !== 1) throw new Error("the decision row was not written");
}

// In its own tenant transaction, with the same membership check as every app statement.
export async function logDecision(db: TenantDb, session: Session, row: DecisionRow): Promise<void> {
  await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    await insertDecision(q, row);
  });
}
