import { randomUUID } from "node:crypto";
import { flags } from "../../../config/flags";
import type { Session } from "../../auth/claims";
import { AiError, complete } from "../../ai";
import { isUuid } from "../../uuid";
import { callTool } from "../gateway";
import { dbAuditStore, type AuditState, type AuditStore, type StoreDeps } from "../gateway/store";
import type { CompleteFn, GatewayContext, GatewayOutcome, ToolCall } from "../gateway/types";
import {
  AUDIT_CALL,
  AUDITOR_MODEL,
  EVIDENCE_DEADLINE_MS,
  LEASE_MS,
  MAX_AUDIT_ATTEMPTS,
  NO_VERDICT,
  VERDICT_FORMAT,
  agreesOf,
  auditorPrompt,
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
// the proposal lets one caller at a time make the call; the verdict is written only on a proposal
// still waiting with none set (and the database refuses any change after). At most one Wonder call
// and one gateway decision per lease, and at most MAX_AUDIT_ATTEMPTS leases make a call.
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
// The outcome is not known, or Meta was busy (429 rate_limited, 5xx unavailable): give the lease
// back so the page's one retry can try again. Every other category is a definite refusal and is
// stored as unknown.
const RETRY_ERRORS: ReadonlySet<string> = new Set([
  "network",
  "timeout",
  "unknown",
  "rate_limited",
  "unavailable",
]);

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

// The ids of the carrier notes the evidence carried, in its order, each once (none while
// carrierMemoryEnabled is off: get_proposal then adds no notes key).
const NOTES_NAMED = 4;
function noteIdsOf(evidence: Record<string, unknown>): string[] {
  const notes = evidence.notes;
  if (!Array.isArray(notes)) return [];
  const ids = notes.flatMap((n) => {
    const id = n && typeof n === "object" ? (n as Record<string, unknown>).id : null;
    return isUuid(id) ? [id] : [];
  });
  return [...new Set(ids)].slice(0, NOTES_NAMED);
}

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
          { role: "system", content: auditorPrompt(noteIdsOf(evidence).length > 0) },
          { role: "user", content: JSON.stringify(evidence) },
        ],
        format: VERDICT_FORMAT,
        traceId,
      },
      session,
    );
    // An answer cut short at the output budget (incomplete) is no answer: the page's retry asks again.
    if (result.status !== "ok") return { retry: true };
    return { verdict: parseVerdict(result.text), callId: result.callId };
  } catch (err) {
    const category = err instanceof AiError ? err.category : "unknown";
    if (RETRY_ERRORS.has(category)) return { retry: true };
    console.warn(`auditor: the audit call was refused (${category}) trace=${traceId}`);
    if (BUDGET_ERRORS.has(category)) return { verdict: { verdict: "unknown", concerns: ["budget"] }, callId: null };
    return { verdict: NO_VERDICT, callId: null };
  }
}

// The code-side engine check (design 3.6), stored on the proposal whatever the call does. A
// failure is logged by its name only and stores nothing (unknown is not a check), and never
// changes the verdict.
async function storeEngineCheck(store: AuditStore, proposalId: string, ctx: GatewayContext): Promise<void> {
  try {
    await store.checkEngine(proposalId, ctx);
  } catch (err) {
    console.warn(
      `auditor: the engine check was not stored (${err instanceof Error ? err.name : "unknown"}) trace=${ctx.traceId}`,
    );
  }
}

// The engine check alone, with no lease and no model call: for a card the auditor did not run on
// (switched off, made before it started, or checked before this check existed). It writes no
// verdict, so auditorEnabled is not read here; a proposal no longer waiting is left as it is.
// Never throws: a failed read is logged by its name only and stores nothing.
export async function runEngineCheck(session: Session, proposalId: string, deps: AuditDeps = {}): Promise<void> {
  const clock = deps.clock ?? (() => new Date());
  const store = deps.store ?? dbAuditStore(session, { db: deps.db, clock });
  let state: AuditState | null;
  try {
    state = await store.read(proposalId);
  } catch (err) {
    console.warn(`auditor: the engine check could not read the proposal (${err instanceof Error ? err.name : "unknown"})`);
    return;
  }
  if (!state || state.status !== "proposed") return;
  const now = clock();
  await storeEngineCheck(store, proposalId, {
    session,
    role: "auditor",
    model: "wonder",
    turnId: state.turnId,
    traceId: state.traceId ?? randomUUID(),
    now,
    deadlineAt: now.getTime() + EVIDENCE_DEADLINE_MS,
    timeZone: state.timeZone,
  });
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

  // b. The lease, which counts this attempt. Zero rows: someone else is checking it now (or it
  // was decided meanwhile).
  const leasedAt = clock();
  const lease = await store.lease(proposalId, leasedAt, LEASE_MS, randomUUID());
  if (lease === null) {
    const now = await store.read(proposalId);
    if (now?.verdict) return doneOf(now);
    return now && now.status === "proposed" ? { state: "in_progress" } : { state: "not_auditable" };
  }
  const { traceId, attempts } = lease;
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
  // The engine's own figure against the proposal's, in code, before any evidence read or call.
  await storeEngineCheck(store, proposalId, ctx);
  // The evidence read gets its own full deadline, so a slow engine check never spends it.
  ctx.deadlineAt = clock().getTime() + EVIDENCE_DEADLINE_MS;

  const write = async (
    verdict: ParsedVerdict,
    callId: string | null,
    notesUsed: readonly string[] = [],
  ): Promise<AuditResult> => {
    // Only while this run still holds its own lease: one that lapsed and was taken over writes
    // nothing, so the newer run's answer is the one stored. The notes the evidence carried are
    // stored with the verdict they informed, in the same write.
    const wrote = await store.write(
      proposalId,
      {
        verdict: verdict.verdict,
        agrees: agreesOf(verdict.verdict),
        callId,
        concerns: verdict.concerns,
        ...(notesUsed.length > 0 ? { notesUsed } : {}),
      },
      clock(),
      leasedAt,
    );
    if (!wrote) {
      console.warn(
        `auditor: proposal ${proposalId} took no verdict (set already, decided, or the lease lapsed) trace=${traceId}`,
      );
    }
    const back = await store.read(proposalId);
    if (back?.verdict) return doneOf(back);
    // Unknown is not zero: a verdict that did not land is never reported. A proposal decided
    // meanwhile takes none; one still waiting (another run holds the lease now, or gave it back)
    // is reported as in progress, with no second call from this run.
    return back && back.status === "proposed" ? { state: "in_progress" } : { state: "not_auditable" };
  };

  // Nothing is known yet: give the lease back so the page's one retry can try again. The last
  // attempt gives nothing back and stores unknown instead, so no later page load calls again.
  const retry = async (): Promise<AuditResult> => {
    if (attempts >= MAX_AUDIT_ATTEMPTS) {
      console.warn(`auditor: no answer after ${attempts} attempts; stored as unknown trace=${traceId}`);
      return write(NO_VERDICT, null);
    }
    await store.release(proposalId, leasedAt);
    return { state: "in_progress" };
  };

  // Past the last attempt (an earlier lease lapsed with no answer and nothing given back): unknown,
  // with no evidence read and no call.
  if (attempts > MAX_AUDIT_ATTEMPTS) return write(NO_VERDICT, null);

  // c. The evidence, through the gateway as the auditor. A refusal (blocked, denied, invalid args,
  // unknown tool) is no evidence and is stored as unknown; a failure (a tool error, or the evidence
  // deadline under load) is not a refusal and gives the lease back. The same database as the
  // store, so an injected one is used end to end.
  const tool = deps.callTool ?? ((c, call) => callTool(c, call, { db: deps.db }));
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
    return retry();
  }
  if (outcome.decision === "failed") return retry();
  if (outcome.decision !== "allowed") return write(NO_VERDICT, null);

  // d. Muse Wonder only: any other configured id is refused before a call.
  const configured = env.META_MODEL_WONDER;
  if (configured !== undefined && configured !== AUDITOR_MODEL) {
    console.error(`auditor: META_MODEL_WONDER is not ${AUDITOR_MODEL}; refusing`);
    return write(NO_VERDICT, null);
  }

  // e. The one call. An outcome that is not known, Meta being busy, or an answer cut short gives
  // the lease back.
  const run: CompleteFn = deps.complete ?? ((target, request, s) => complete(target, request, s, { db: deps.db }));
  const called = await askWonder(session, outcome.result, traceId, run);
  if ("retry" in called) return retry();

  // f. Write once, then read back what is stored. The notes are named only when a call answered:
  // a refused call showed them to no model.
  return write(called.verdict, called.callId, called.callId === null ? [] : noteIdsOf(outcome.result));
}
