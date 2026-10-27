import { randomUUID } from "node:crypto";
import { flags } from "../../../config/flags";
import type { Session } from "../../auth/claims";
import { AiError, complete } from "../../ai";
import { callTool } from "../gateway";
import { dbAuditStore, type AuditState, type AuditStore, type StoreDeps } from "../gateway/store";
import type { CompleteFn, GatewayContext, GatewayOutcome, ToolCall } from "../gateway/types";
import {
  AUDIT_CALL,
  AUDITOR_MODEL,
  AUDITOR_PROMPT,
  EVIDENCE_DEADLINE_MS,
  LEASE_MS,
  NO_VERDICT,
  VERDICT_FORMAT,
  agreesOf,
  isAuditConcern,
  isAuditVerdict,
  parseVerdict,
  type AuditConcern,
  type AuditVerdict,
  type ParsedVerdict,
} from "./policy";

// The auditor (design 4.2): one Muse Wonder call per proposal, over evidence read through the
// gateway (get_proposal, auditor role only), never over untrusted text. It reads, checks and writes
// its verdict on the proposal; it never approves, never moves money and holds no path to the
// ledger. PAY-SWEEP calls runAudit directly, with no model loop around it.
//
// Idempotent end to end: a verdict already stored is read back with no call; a 90-second lease on
// the proposal lets one caller at a time make the call; the verdict is written only where none is
// set (and the database refuses any change after). At most one Wonder call and one gateway
// decision per lease.
//
// This is one of the two agent files that may import the model wrapper (the import-boundary test).

export { AiError };

export type AuditResult =
  | { state: "done"; verdict: AuditVerdict; concerns: AuditConcern[]; checkedAt: string | null }
  | { state: "in_progress" }
  | { state: "disabled" | "not_found" | "not_auditable" };

export type AuditDeps = {
  db?: StoreDeps["db"];
  clock?: () => Date;
  complete?: CompleteFn;
  callTool?: (ctx: GatewayContext, call: ToolCall) => Promise<GatewayOutcome>;
  store?: AuditStore;
  // The environment the model id is read from. Default process.env.
  env?: Record<string, string | undefined>;
};

// The wrapper refused for money: the card says the demo budget was reached.
const BUDGET_ERRORS: ReadonlySet<string> = new Set(["cap", "too_expensive", "billing"]);
// The outcome is not known: give the lease back so the page's one retry can try again.
const RETRY_ERRORS: ReadonlySet<string> = new Set(["network", "timeout", "unknown"]);

function doneOf(state: AuditState): AuditResult {
  const verdict = isAuditVerdict(state.verdict) ? state.verdict : "unknown";
  return {
    state: "done",
    verdict,
    concerns: state.concerns.filter(isAuditConcern),
    checkedAt: state.checkedAt,
  };
}

function startedBefore(state: AuditState): boolean {
  const created = Date.parse(state.createdAt);
  const start = Date.parse(flags.auditorStart);
  // Unknown is not zero: an unreadable date is never audited.
  return !Number.isFinite(created) || !Number.isFinite(start) || created < start;
}

type Called = { verdict: ParsedVerdict; callId: string | null } | { retry: true };

async function askWonder(
  session: Session,
  evidence: Record<string, unknown>,
  traceId: string,
  run: CompleteFn,
): Promise<Called> {
  try {
    const result = await run(
      "wonder",
      {
        ...AUDIT_CALL,
        messages: [
          { role: "system", content: AUDITOR_PROMPT },
          { role: "user", content: JSON.stringify(evidence) },
        ],
        format: VERDICT_FORMAT,
        traceId,
      },
      session,
    );
    if (result.status !== "ok") return { verdict: NO_VERDICT, callId: result.callId };
    return { verdict: parseVerdict(result.text), callId: result.callId };
  } catch (err) {
    const category = err instanceof AiError ? err.category : "unknown";
    if (RETRY_ERRORS.has(category)) return { retry: true };
    console.warn(`auditor: the audit call was refused (${category}) trace=${traceId}`);
    if (BUDGET_ERRORS.has(category)) return { verdict: { verdict: "unknown", concerns: ["budget"] }, callId: null };
    return { verdict: NO_VERDICT, callId: null };
  }
}

export async function runAudit(
  session: Session,
  proposalId: string,
  deps: AuditDeps = {},
): Promise<AuditResult> {
  // The switch is read on every run, here, not by the caller.
  if (!flags.auditorEnabled) return { state: "disabled" };
  const clock = deps.clock ?? (() => new Date());
  const store = deps.store ?? dbAuditStore(session, { db: deps.db, clock });
  const env = deps.env ?? process.env;

  // a. Read the proposal. A verdict already stored is the answer.
  const state = await store.read(proposalId);
  if (!state) return { state: "not_found" };
  if (state.verdict !== null) return doneOf(state);
  if (state.status !== "proposed" || startedBefore(state)) return { state: "not_auditable" };

  // b. The lease. Zero rows: someone else is checking it now (or it was decided meanwhile).
  const leasedAt = clock();
  const traceId = await store.lease(proposalId, leasedAt, LEASE_MS, randomUUID());
  if (traceId === null) {
    const now = await store.read(proposalId);
    if (now?.verdict) return doneOf(now);
    return now && now.status === "proposed" ? { state: "in_progress" } : { state: "not_auditable" };
  }

  const write = async (verdict: ParsedVerdict, callId: string | null): Promise<AuditResult> => {
    const wrote = await store.write(
      proposalId,
      { verdict: verdict.verdict, agrees: agreesOf(verdict.verdict), callId, concerns: verdict.concerns },
      clock(),
    );
    if (!wrote) console.warn(`auditor: proposal ${proposalId} already had a verdict trace=${traceId}`);
    const back = await store.read(proposalId);
    if (back?.verdict) return doneOf(back);
    // Unknown is not zero: a write that did not land and cannot be read back is not done.
    return { state: "in_progress" };
  };

  // c. The evidence, through the gateway as the auditor. Anything but allowed is no evidence.
  // The same database as the store, so an injected one is used end to end.
  const tool = deps.callTool ?? ((ctx, call) => callTool(ctx, call, { db: deps.db }));
  const ctx: GatewayContext = {
    session,
    role: "auditor",
    model: "wonder",
    turnId: state.turnId,
    traceId,
    now: leasedAt,
    deadlineAt: leasedAt.getTime() + EVIDENCE_DEADLINE_MS,
    timeZone: state.timeZone,
  };
  let outcome: GatewayOutcome;
  try {
    outcome = await tool(ctx, {
      id: `audit-${proposalId}`,
      name: "get_proposal",
      argumentsJson: JSON.stringify({ proposalId }),
    });
  } catch (err) {
    // The gateway could not even log its decision: nothing is known, so nothing is stored.
    console.error("auditor: the evidence read failed:", err instanceof Error ? err.name : "unknown");
    await store.release(proposalId, leasedAt);
    return { state: "in_progress" };
  }
  if (outcome.decision !== "allowed") return write(NO_VERDICT, null);

  // d. Muse Wonder only: any other configured id is refused before a call.
  const configured = env.META_MODEL_WONDER;
  if (configured !== undefined && configured !== AUDITOR_MODEL) {
    console.error(`auditor: META_MODEL_WONDER is not ${AUDITOR_MODEL}; refusing`);
    return write(NO_VERDICT, null);
  }

  // e. The one call. An outcome that is not known gives the lease back.
  const run: CompleteFn = deps.complete ?? ((target, request, s) => complete(target, request, s, { db: deps.db }));
  const called = await askWonder(session, outcome.result, traceId, run);
  if ("retry" in called) {
    await store.release(proposalId, leasedAt);
    return { state: "in_progress" };
  }

  // f. Write once, then read back what is stored.
  return write(called.verdict, called.callId);
}
