import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { readAdvanceInput } from "../data/read";
import { executeMoneyAction, type MoneyDeps, type MoneyHooks } from "../money/execute";
import { isCanonicalUuid } from "../money/keys";
import { readBySubject, readTenantZone } from "../money/read";
import { reconcileMoneyActions, type ReconcileHooks, type ReconcileSummary } from "../money/reconcile";
import { MAX_ATTEMPT, MoneyError, type MoneyAction, type MoneyFailure } from "../money/types";
import type { ApproveOptions, ExecuteDeps, ProposalResult, ProposalRow } from "../proposals/execute";
import { advanceEligibility, type AdvanceDecision } from "../rules-engine";
import { assertMembership } from "../tenant/context";
import { localDateOf } from "../time/local-date";
import { expenseReconcileHooks, postAdvanceExpense } from "./post-expense";
import { requestRefOf, sourceOfInput } from "./request";
import { readFlowAdvance, readFlowAdvanceByProposal, type FlowAdvance } from "./rows";
import { advancesOn, payoutGate } from "./switches";

// A person approves an advance proposal, and only then does the advance exist (design D2). The
// proposal gate (src/lib/proposals/execute.ts) has already checked the role, the auditor and the
// second confirm; this executor then, in one tenant transaction with the proposal and the driver
// locked: asks the payout switches, re-runs the rules engine as of now (a proposal whose numbers
// no longer hold is rejected, never paid), moves the proposal to approved and executing, and
// writes the advances row as requested. The money executor then reserves the payout's ledger row
// (the advance becomes approved in that same transaction), makes the one outside call and settles
// it: paid, failed (a person may retry), or unknown (Check pending reads it back). When the payout
// is confirmed with time left in the request, the QuickBooks post runs too (design D3); if not,
// the record page's button posts it later.
//
// Every state this leaves is one a later approval, retry or check adopts: a second approval finds
// the advance by its proposal and the ledger row by its key, so nothing is paid twice.

export type AdvanceDeps = ExecuteDeps & {
  // Ledger and adapter overrides (tests pass the mock adapter and short timeouts).
  money?: Partial<MoneyDeps>;
  // A monotonic clock for the request's time budget.
  steady?: () => number;
  newId?: () => string;
};

export type FlowResult =
  | { ok: true; advanceId: string; status: "paid" | "pending" | "posted"; moneyActionId: string }
  | { ok: false; category: string; retryable: boolean };

// The approve request's own budget; the QuickBooks leg runs only with enough of it left.
const REQUEST_BUDGET_MS = 25_000;
const NOTE_MAX = 240;

class Stop extends Error {
  readonly result: { ok: false; category: string; retryable: boolean };
  constructor(category: string, retryable = false) {
    super(`advances: ${category}`);
    this.name = "Stop";
    this.result = { ok: false, category, retryable };
  }
}

const no = (category: string, retryable = false) => ({ ok: false as const, category, retryable });

function steadyOf(deps: AdvanceDeps): () => number {
  return deps.steady ?? (() => performance.now());
}

// ---- The ledger hooks, shared by approval, retry and the reconcile pass ----

// In the reserve transaction: the advance becomes approved, naming the member whose approval
// reserved it, and the proposal records its first ledger row. Must change the advance or throw.
async function onPayoutReserved(q: Queryable, action: MoneyAction): Promise<void> {
  const changed = await q.execute(
    `UPDATE advances
        SET status = 'approved',
            decided_at = COALESCE(decided_at, CAST($3 AS timestamptz)),
            decided_by_membership_id = COALESCE(decided_by_membership_id, CAST($2 AS uuid))
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND proposal_id IS NOT NULL
        AND status IN ('requested', 'approved')`,
    [action.subjectId, action.approverMembershipId, action.createdAt],
  );
  if (changed !== 1) throw new MoneyError("validation");
  if (action.proposalId) {
    await q.execute(
      `UPDATE proposals SET money_action_id = CAST($2 AS uuid), updated_at = now()
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND money_action_id IS NULL`,
      [action.proposalId, action.id],
    );
  }
}

// In the settle transaction: the advance is paid as of the settle, and the proposal is done.
// A paid advance stays paid (a read-back after a lost reply lands here too). Anything else (an
// advance canceled while the money moved) throws, so the row stays open for a person.
async function onPayoutConfirmed(q: Queryable, action: MoneyAction): Promise<void> {
  const changed = await q.execute(
    `UPDATE advances
        SET status = 'paid', paid_at = COALESCE(paid_at, CAST($2 AS timestamptz), now())
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND proposal_id IS NOT NULL
        AND status IN ('approved', 'paid')`,
    [action.subjectId, action.settledAt],
  );
  if (changed !== 1) throw new MoneyError("validation");
  if (action.proposalId) {
    await q.execute(
      `UPDATE proposals SET status = 'done', updated_at = now()
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
      [action.proposalId],
    );
  }
}

// A definite failure: no money moved. The advance stays approved (a person may retry it); the
// proposal ends as failed. After a later retry pays, the advance row is the truth (there is no
// failed-to-done transition for a proposal).
async function onPayoutFailed(q: Queryable, action: MoneyAction): Promise<void> {
  if (!action.proposalId) return;
  await q.execute(
    `UPDATE proposals SET status = 'failed', updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status IN ('approved', 'executing')`,
    [action.proposalId],
  );
}

export const payoutHooks: MoneyHooks = {
  onReserved: onPayoutReserved,
  onConfirmed: onPayoutConfirmed,
  onFailed: onPayoutFailed,
};

export const payoutReconcileHooks: ReconcileHooks = {
  onConfirmed: onPayoutConfirmed,
  onFailed: onPayoutFailed,
};

// ---- Shared reads ----

async function memberRole(q: Queryable, session: Session): Promise<string | null> {
  await assertMembership(q, session);
  const rows = await q.query<{ role: string }>(
    "SELECT role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  return rows.length === 1 ? rows[0].role : null;
}

const needsAdmin = (amountCents: number, role: string | null) =>
  amountCents > flags.approverRole.adminAboveCents && role !== "admin";

async function payoutRows(q: Queryable, advanceId: string): Promise<MoneyAction[]> {
  return (await readBySubject(q, "advances", advanceId)).filter((a) => a.kind === "advance_payout");
}

async function lockDriver(q: Queryable, driverId: string): Promise<boolean> {
  const rows = await q.query<{ id: string }>(
    "SELECT id FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE",
    [driverId],
  );
  return rows.length === 1;
}

// Where the ask came from: the outside message the proposal names, when it is this tenant's.
async function sourceOf(
  q: Queryable,
  requestRef: unknown,
): Promise<{ source: ReturnType<typeof sourceOfInput>; inputId: string | null }> {
  if (!isCanonicalUuid(requestRef)) return { source: "ui", inputId: null };
  const rows = await q.query<{ kind: string }>(
    "SELECT kind FROM untrusted_inputs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [requestRef],
  );
  if (rows.length !== 1) return { source: "ui", inputId: null };
  return { source: sourceOfInput(rows[0].kind), inputId: requestRef };
}

function moneyRefusal(category: MoneyFailure, disabledAs: string) {
  if (category === "disabled") return no(disabledAs);
  if (category === "validation" || category === "duplicate") return no("unavailable");
  return no("unavailable", true);
}

function noteOf(decision: AdvanceDecision): string {
  const codes = decision.reasons.length > 0 ? decision.reasons.join(",") : "amount_changed";
  return `stale_eligibility: ${codes}`.slice(0, NOTE_MAX);
}

// ---- Approval ----

type ProposalLock = { status: string; createdAt: string };

type Prepared =
  | { kind: "pay"; advance: FlowAdvance; attempt: number }
  | { kind: "stale" }
  | { kind: "failed" };

function validProposal(p: ProposalRow): boolean {
  return (
    p.kind === "advance_payout" &&
    p.subjectTable === "drivers" &&
    isCanonicalUuid(p.subjectId) &&
    p.args.driverId === p.subjectId &&
    Number.isSafeInteger(p.amountCents) &&
    p.amountCents > 0 &&
    p.args.amountCents === p.amountCents
  );
}

// Runs inside one tenant transaction, after the proposal gate moved the proposal to approved (or
// on a resume, with it approved or executing). Per the executor contract it never sets approved
// itself and asks no role or confirm question again: those passed under the gate's lock and the
// person's approval stands. It re-reads its own advance and ledger rows before any work.
async function prepare(q: Queryable, p: ProposalRow, now: Date, newId: () => string): Promise<Prepared> {
  const locked = await q.query<{ status: string; created_at: string }>(
    `SELECT status,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'advance_payout'
      FOR UPDATE`,
    [p.id],
  );
  if (locked.length !== 1) throw new Stop("not_found");
  const lock: ProposalLock = { status: locked[0].status, createdAt: locked[0].created_at };
  // A waiting proposal never reaches an executor; a decided one has nothing left to run.
  if (lock.status === "proposed") throw new Stop("not_executable");
  if (lock.status !== "approved" && lock.status !== "executing") throw new Stop("already_decided");

  const nowIso = now.toISOString();
  const zone = await readTenantZone(q);
  const refusal = payoutGate(p.amountCents, localDateOf(nowIso, zone));
  if (refusal) throw new Stop(refusal);
  if (!(await lockDriver(q, p.subjectId))) throw new Stop("not_found");

  let advance = await readFlowAdvanceByProposal(q, p.id);
  const rows = advance ? await payoutRows(q, advance.id) : [];
  const latest = rows.at(-1) ?? null;

  if (!advance) {
    let decision: AdvanceDecision;
    try {
      decision = advanceEligibility(await readAdvanceInput(q, p.subjectId, nowIso, p.amountCents));
    } catch {
      throw new Stop("eligibility_unavailable", true);
    }
    if (!decision.eligible || decision.approvedCents !== p.amountCents) {
      // The numbers changed since the proposal: it is never paid. Written and returned (the
      // commit keeps the outcome), so the card and the record say why.
      await q.execute(
        `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
            AND status IN ('approved', 'executing')`,
        [p.id, noteOf(decision), nowIso],
      );
      return { kind: "stale" };
    }
    const from = await sourceOf(q, p.args.requestRef);
    await q.execute(
      `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on,
                             amount_cents, fee_cents, status, source, proposal_id, source_input_id)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST($4 AS timestamptz),
               CAST($5 AS date), $6, $7, 'requested', $8, CAST($9 AS uuid), CAST($10 AS uuid))
       ON CONFLICT (tenant_id, proposal_id) WHERE proposal_id IS NOT NULL DO NOTHING`,
      [
        newId(),
        p.subjectId,
        requestRefOf(p.id),
        lock.createdAt,
        localDateOf(lock.createdAt, zone),
        p.amountCents,
        decision.feeCents,
        from.source,
        p.id,
        from.inputId,
      ],
    );
    advance = await readFlowAdvanceByProposal(q, p.id);
    if (!advance) throw new DbError("unknown");
  }
  if (lock.status === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      [p.id, nowIso],
    );
  }
  if (advance.status === "rejected" || advance.status === "cancelled") throw new Stop("already_decided");
  if (latest?.state === "failed") {
    // A definite failure ends the approval; a person retries from the advance's page.
    await onPayoutFailed(q, latest);
    return { kind: "failed" };
  }
  return { kind: "pay", advance, attempt: latest ? latest.attempt : 1 };
}

export async function executeAdvanceProposal(
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  _opts: ApproveOptions,
  deps: AdvanceDeps,
): Promise<ProposalResult> {
  if (!advancesOn()) return no("disabled");
  if (!validProposal(proposal)) return no("not_executable");
  const steady = steadyOf(deps);
  const started = steady();
  const now = (deps.clock ?? (() => new Date()))();
  const newId = deps.newId ?? randomUUID;

  let prepared: Prepared;
  try {
    prepared = await db.withTenant(session.tenantId, (q) => prepare(q, proposal, now, newId));
  } catch (err) {
    if (err instanceof Stop) return err.result;
    if (err instanceof DbError && err.sqlState === "23505") return no("ref_collision");
    throw err;
  }
  if (prepared.kind === "stale") return no("stale_eligibility");
  if (prepared.kind === "failed") return no("payout_failed", true);
  const { advance, attempt } = prepared;
  if (advance.status === "paid") {
    return { ok: true, proposalId: proposal.id, status: "done", moneyActionId: proposal.moneyActionId };
  }

  const paid = await pay(db, session, advance, attempt, proposal.traceId, deps, "payouts_off");
  if (!paid.ok) return paid;
  if (paid.state === "confirmed") {
    await legTwo(db, session, advance.id, deps, REQUEST_BUDGET_MS - (steady() - started));
    return { ok: true, proposalId: proposal.id, status: "done", moneyActionId: paid.actionId };
  }
  return { ok: true, proposalId: proposal.id, status: "executing", moneyActionId: paid.actionId };
}

type Paid =
  | { ok: true; state: "confirmed" | "pending"; actionId: string }
  | { ok: false; category: string; retryable: boolean };

async function pay(
  db: TenantDb,
  session: Session,
  advance: FlowAdvance,
  attempt: number,
  traceId: string | null,
  deps: AdvanceDeps,
  disabledAs: string,
): Promise<Paid> {
  try {
    const r = await executeMoneyAction(
      db,
      session,
      {
        kind: "advance_payout",
        subjectId: advance.id,
        counterpartyId: advance.driverId,
        amountCents: advance.amountCents,
        attempt,
        proposedBy: "agent",
        proposalId: advance.proposalId,
        traceId: isCanonicalUuid(traceId) ? traceId : null,
        subjectStatuses: ["requested", "approved"],
      },
      payoutHooks,
      deps.money,
    );
    if (r.action.state === "confirmed") return { ok: true, state: "confirmed", actionId: r.action.id };
    if (r.action.state === "failed") return no("payout_failed", r.action.failureCategory !== "amount_mismatch");
    return { ok: true, state: "pending", actionId: r.action.id };
  } catch (err) {
    if (err instanceof MoneyError) return moneyRefusal(err.category, disabledAs);
    if (err instanceof Error && err.name === "ForbiddenError") throw err;
    console.error("advance payout did not finish:", err instanceof Error ? err.name : "unknown");
    return no("unavailable", true);
  }
}

// The QuickBooks leg after a confirmed payout, inside the same request when the switch is on and
// time is left. Its outcome never changes the payout's: a post left undone shows as pending on
// the advance's page, with a button.
async function legTwo(
  db: TenantDb,
  session: Session,
  advanceId: string,
  deps: AdvanceDeps,
  remainingMs: number,
): Promise<void> {
  if (flags.accountingEnabled !== true) return;
  if (remainingMs <= flags.advancesLimits.legTwoMinRemainingMs) return;
  try {
    await postAdvanceExpense(session, advanceId, { ...deps, db, onlyFirst: true });
  } catch (err) {
    console.error("advance post did not finish:", err instanceof Error ? err.name : "unknown");
  }
}

// ---- Retry and check ----

// A person retries a payout that definitely failed, as the next attempt, or sends the first one
// when the approval stopped before it. Unknown or still-sent payouts are never retried (they may
// have paid): Check pending reads them back instead.
export async function retryAdvancePayout(
  session: Session,
  advanceId: string,
  deps: AdvanceDeps = {},
): Promise<FlowResult> {
  if (!advancesOn()) return no("disabled");
  const db = deps.db ?? getDb();
  const steady = steadyOf(deps);
  const started = steady();
  const now = (deps.clock ?? (() => new Date()))();
  let picked: { advance: FlowAdvance; attempt: number; traceId: string | null };
  try {
    picked = await db.withTenant(session.tenantId, async (q) => {
      const role = await memberRole(q, session);
      const advance = await readFlowAdvance(q, advanceId, true);
      if (!advance) throw new Stop("not_found");
      const latest = (await payoutRows(q, advance.id)).at(-1) ?? null;
      // An approved advance after a definite failure, or a requested one whose approval stopped
      // before its first ledger row (the payment service was not ready): a person approved both.
      if (advance.status !== "approved" && !(advance.status === "requested" && latest === null)) {
        throw new Stop("not_retryable");
      }
      let attempt = 1;
      if (latest) {
        if (latest.state === "reserved" || latest.state === "sent" || latest.state === "unknown") {
          throw new Stop("payout_pending");
        }
        if (latest.state !== "failed" || latest.failureCategory === "amount_mismatch") {
          throw new Stop("not_retryable");
        }
        attempt = latest.attempt + 1;
      }
      if (attempt > flags.advancesLimits.maxPayoutAttempts || attempt > MAX_ATTEMPT) {
        throw new Stop("attempts_exhausted");
      }
      if (needsAdmin(advance.amountCents, role)) throw new Stop("role");
      const zone = await readTenantZone(q);
      const refusal = payoutGate(advance.amountCents, localDateOf(now.toISOString(), zone));
      if (refusal) throw new Stop(refusal);
      return { advance, attempt, traceId: latest?.traceId ?? null };
    });
  } catch (err) {
    if (err instanceof Stop) return err.result;
    throw err;
  }
  const paid = await pay(db, session, picked.advance, picked.attempt, picked.traceId, deps, "payouts_off");
  if (!paid.ok) return paid;
  if (paid.state === "confirmed") {
    await legTwo(db, session, picked.advance.id, deps, REQUEST_BUDGET_MS - (steady() - started));
    return { ok: true, advanceId: picked.advance.id, status: "paid", moneyActionId: paid.actionId };
  }
  return { ok: true, advanceId: picked.advance.id, status: "pending", moneyActionId: paid.actionId };
}

// Check pending: the reconcile pass over this tenant's open advance payouts and posts (the pass is
// tenant-wide; the ledger reads back by request id). Never sends anything new; a payout found
// paid gets the same follow-up write the approval would have made.
export async function checkAdvancePayouts(
  session: Session,
  advanceId: string,
  deps: AdvanceDeps = {},
): Promise<{ ok: true; summary: ReconcileSummary } | { ok: false; category: string; retryable: boolean }> {
  if (!advancesOn()) return no("disabled");
  const db = deps.db ?? getDb();
  // The button lives on one advance's page: it must be this carrier's flow advance.
  const found = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return (await readFlowAdvance(q, advanceId)) !== null;
  });
  if (!found) return no("not_found");
  const summary = await reconcileMoneyActions(
    db,
    session,
    {
      hooks: {
        advance_payout: payoutReconcileHooks,
        advance_expense: expenseReconcileHooks(db, session.tenantId, deps.money),
      },
      limit: 5,
      olderThanSeconds: 60,
    },
    deps.money,
  );
  return { ok: true, summary };
}
