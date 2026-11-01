import { z } from "zod";
import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import type { ExecuteResult } from "../money/execute";
import { readBySubject } from "../money/read";
import { MoneyError } from "../money/types";
import type { ExecuteDeps, Executor, ProposalResult, ProposalRow } from "../proposals/execute";
import { bookPaidSettlement } from "./book";
import { linesHash } from "./hash";
import {
  bookConfirmedPayout,
  finishProposal,
  planLeg,
  refuseStalePayout,
  runAccountingLegs,
  sendLeg,
  type SettlementMoneyDeps,
} from "./legs";
import { isUuid } from "../uuid";
import { parkSettlement, readStoredLines, readStoredSettlement, recheckSettlement } from "./stored";

// The settlement_approve executor: a person approved the engine's paystub for one driver and week.
//
// (a) One tenant transaction, the proposal and the settlement locked: the card's numbers must
// equal the stored draft whole (totals, driver, week, the lines' fingerprint), or the card is
// stale. Then the pre-pay recheck: a fresh engine run over the records as they stand now, compared
// whole with the stored paystub, and every record a line cites checked. Any difference parks the
// draft (only "Run the week" clears a park) and fails the card 'parked'; nothing is reserved. A
// clean recheck moves the settlement to approved and the card to executing, together.
//
// A net-$0 week books right there (paid, escrow columns, next week's carried shortfall), with no
// money leg at all, and the card ends done 'no_payout'.
//
// (b) The payout through the money executor (ledger key settlement_payout:<id>:<attempt>). Once its
// confirmation is recorded, the paystub is booked as paid in its own transaction and the card ends
// done; a booking that does not go through leaves the payout confirmed, the card executing with
// the note not_booked, and the bill legs unsent until a resume or Retry books it (never sending
// again). A resumed approve re-checks the paystub against its records before the payout goes, as
// the batch drain and Retry payout do, and refuses a stale one. payoutsEnabled off: nothing is
// reserved, the executor logs what it would send, the settlement stays approved and the card ends
// done 'not_paid' ("Retry payout" sends it once the switch is on). A payment adapter that is not
// ready (not connected, not configured) also refuses before anything is reserved, but the driver
// was not paid, so the card ends failed with that category, as the batch drain ends it; the
// settlement stays approved and "Retry payout" sends it once the adapter is ready.
//
// (c) The bill and its payment, only when enough of the request budget is left; otherwise the
// record page's "Post to QuickBooks" sends them later. Their outcome never changes the card.

export const SettlementArgs = z.object({
  settlementId: z.uuid(),
  driverId: z.uuid(),
  periodId: z.uuid(),
  grossCents: z.int().nonnegative(),
  deductionsCents: z.int().nonnegative(),
  netCents: z.int().nonnegative(),
  carryForwardCents: z.int().nonnegative(),
  linesHash: z.string().regex(/^[0-9a-f]{64}$/),
});

type ProposalState = {
  status: string;
  money_action_id: string | null;
  decision_note: string | null;
  batch_id: string | null;
};

const failed = (category: string): ProposalResult => ({ ok: false, category, retryable: false });

function resultOf(proposalId: string, p: ProposalState): ProposalResult {
  if (p.status === "failed") return failed(p.decision_note ?? "failed");
  return { ok: true, proposalId, status: p.status, moneyActionId: p.money_action_id };
}

async function failApproved(q: Queryable, proposalId: string, note: string, now: Date): Promise<ProposalResult> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
    [proposalId, note, now.toISOString()],
  );
  return failed(note);
}

async function readState(q: Queryable, proposalId: string, lock: boolean): Promise<ProposalState | null> {
  const [p] = await q.query<ProposalState>(
    `SELECT status, money_action_id, decision_note, batch_id FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)${lock ? " FOR UPDATE" : ""}`,
    [proposalId],
  );
  return p ?? null;
}

export type PayStep = {
  settlementId: string;
  driverId: string;
  netCents: number;
  batchId: string | null;
};

type Phase = { kind: "result"; result: ProposalResult } | { kind: "pay"; step: PayStep };

// The card's numbers against the stored draft, whole. Any difference is a stale card.
export function sameAsStored(
  args: z.infer<typeof SettlementArgs>,
  proposal: { amountCents: number },
  stored: { driverId: string; periodId: string; grossCents: number; deductionsCents: number; netCents: number; carryForwardCents: number },
  hash: string,
): boolean {
  return (
    args.driverId === stored.driverId &&
    args.periodId === stored.periodId &&
    args.grossCents === stored.grossCents &&
    args.deductionsCents === stored.deductionsCents &&
    args.netCents === stored.netCents &&
    args.carryForwardCents === stored.carryForwardCents &&
    proposal.amountCents === stored.netCents &&
    args.linesHash === hash
  );
}

// Phase (a), in one locked transaction.
async function prepare(q: Queryable, proposal: ProposalRow, now: Date): Promise<Phase> {
  // Switch off: nothing is written and the card stays approved, so it resumes once it is on.
  if (!flags.settlementsEnabled) return { kind: "result", result: failed("disabled") };
  // Locks go paystub first, then its card: the order the run, the batch confirm and the payout's
  // booking use too, so two of them never wait on each other.
  if (proposal.subjectTable === "settlements" && isUuid(proposal.subjectId)) {
    await readStoredSettlement(q, proposal.subjectId, true);
  }
  const p = await readState(q, proposal.id, true);
  if (!p) return { kind: "result", result: failed("not_found") };
  if (p.status !== "approved" && p.status !== "executing") {
    return { kind: "result", result: resultOf(proposal.id, p) };
  }
  const parsed = SettlementArgs.safeParse(proposal.args);
  if (!parsed.success || proposal.subjectTable !== "settlements" || parsed.data.settlementId !== proposal.subjectId) {
    if (p.status === "approved") return { kind: "result", result: await failApproved(q, proposal.id, "validation", now) };
    return { kind: "result", result: failed("validation") };
  }
  const args = parsed.data;
  const stored = await readStoredSettlement(q, args.settlementId, true);

  if (p.status === "executing") {
    if (!stored) return { kind: "result", result: failed("not_found") };
    if (stored.status === "paid") {
      await finishProposal(q, stored.id, "done", null, now);
      const after = await readState(q, proposal.id, false);
      return { kind: "result", result: after ? resultOf(proposal.id, after) : failed("not_found") };
    }
    if (stored.status !== "approved") return { kind: "result", result: failed("unknown") };
    if (await refuseStalePayout(q, stored, now)) {
      const after = await readState(q, proposal.id, false);
      return { kind: "result", result: after ? resultOf(proposal.id, after) : failed("not_found") };
    }
    return {
      kind: "pay",
      step: { settlementId: stored.id, driverId: stored.driverId, netCents: stored.netCents, batchId: p.batch_id },
    };
  }

  // approved: the draft must still be a draft, unparked, and equal to the card.
  if (!stored || stored.status !== "draft") return { kind: "result", result: await failApproved(q, proposal.id, "stale", now) };
  if (stored.parkedReason !== null) return { kind: "result", result: await failApproved(q, proposal.id, "parked", now) };
  const lines = await readStoredLines(q, stored.id);
  if (!sameAsStored(args, proposal, stored, linesHash(lines))) {
    return { kind: "result", result: await failApproved(q, proposal.id, "stale", now) };
  }
  // The pre-pay recheck. A park is a definite refusal: nothing is reserved.
  const check = await recheckSettlement(q, stored, lines);
  if (check.park !== null) {
    await parkSettlement(q, stored.id, check.park, now);
    // A typed line that contradicts its record ends the card with that refusal word itself.
    const note = check.park === "contradicting_line" ? "contradicting_line" : "parked";
    return { kind: "result", result: await failApproved(q, proposal.id, note, now) };
  }
  const nowIso = now.toISOString();
  const moved = await q.execute(
    `UPDATE settlements SET status = 'approved'
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'draft'
        AND parked_reason IS NULL`,
    [stored.id],
  );
  const started = await q.execute(
    `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
    [proposal.id, nowIso],
  );
  // Both rows are locked above, so anything but one row each means the database moved under us.
  if (moved !== 1 || started !== 1) throw new Error("settlement approve lost its lock");

  if (stored.netCents === 0) {
    // Nothing to send: the week books as paid with its shortfall carried to next week.
    await bookPaidSettlement(q, stored.id, now);
    await finishProposal(q, stored.id, "done", "no_payout", now);
    console.info(
      `settlements: no payout, net 0, carried ${stored.carryForwardCents} for settlement ${stored.id}`,
    );
    const after = await readState(q, proposal.id, false);
    return { kind: "result", result: after ? resultOf(proposal.id, after) : failed("not_found") };
  }
  return {
    kind: "pay",
    step: { settlementId: stored.id, driverId: stored.driverId, netCents: stored.netCents, batchId: p.batch_id },
  };
}

// The card's last move, then its state as stored.
async function finish(
  db: TenantDb,
  session: Session,
  proposalId: string,
  settlementId: string,
  to: "done" | "failed",
  note: string | null,
  now: Date,
): Promise<ProposalResult> {
  const state = await db.withTenant(session.tenantId, async (q) => {
    await finishProposal(q, settlementId, to, note, now);
    return readState(q, proposalId, false);
  });
  return state ? resultOf(proposalId, state) : failed("not_found");
}

// The request budget left, in milliseconds, for the bill legs.
export function remainingMs(startedMs: number, nowMs: number): number {
  return startedMs + flags.batchLimits.drainBudgetMs - nowMs;
}

// Phase (b) and (c).
async function payAndFinish(
  db: TenantDb,
  session: Session,
  proposalId: string,
  step: PayStep,
  money: SettlementMoneyDeps,
  clock: () => Date,
  startedMs: number,
): Promise<ProposalResult> {
  const nowMs = money.nowMs ?? (() => Date.now());
  const rows = await db.withTenant(session.tenantId, (q) => readBySubject(q, "settlements", step.settlementId));
  const plan = planLeg(rows, "settlement_payout", false);
  if (!plan.go) {
    if (plan.state === "failed") {
      const latest = rows.filter((a) => a.kind === "settlement_payout").sort((a, b) => b.attempt - a.attempt)[0];
      return finish(db, session, proposalId, step.settlementId, "failed", latest?.failureCategory ?? "unknown", clock());
    }
    if (plan.state === "unknown") {
      return { ok: true, proposalId, status: "executing", moneyActionId: null };
    }
  }

  let out: ExecuteResult | null = null;
  if (plan.go) {
    try {
      out = await sendLeg(
        db,
        session,
        "settlement_payout",
        step,
        { attempt: plan.attempt, proposalId, batchId: step.batchId },
        money,
        clock,
      );
    } catch (err) {
      if (!(err instanceof MoneyError)) throw err;
      if (err.category === "disabled") return finish(db, session, proposalId, step.settlementId, "done", "not_paid", clock());
      // Nobody knows whether anything was sent: the card stays executing for the reconcile pass.
      if (err.category === "unknown") throw err;
      return finish(db, session, proposalId, step.settlementId, "failed", err.category, clock());
    }
    const action = out.action;
    if (action.state === "failed") {
      return finish(db, session, proposalId, step.settlementId, "failed", action.failureCategory ?? "unknown", clock());
    }
    if (action.state !== "confirmed") {
      return { ok: true, proposalId, status: "executing", moneyActionId: action.id };
    }
  }

  // Confirmed (now or by an earlier call): the paystub is booked once, in its own transaction, and
  // the card ends done. A booking that does not go through stops the bill legs, as a failed leg does.
  if ((await bookConfirmedPayout(db, session.tenantId, step.settlementId, clock)) !== "booked") {
    const state = await db.withTenant(session.tenantId, (q) => readState(q, proposalId, false));
    return state ? resultOf(proposalId, state) : failed("not_found");
  }

  if (remainingMs(startedMs, nowMs()) > flags.settlementLimits.legTwoMinRemainingMs) {
    const left = remainingMs(startedMs, nowMs()) - 2_000;
    const timeoutMs = Math.max(1_000, Math.min(money.timeoutMs ?? 20_000, left));
    try {
      await runAccountingLegs(
        db,
        session,
        step.settlementId,
        { proposalId, batchId: step.batchId, retryFailed: false },
        { ...money, timeoutMs },
        clock,
      );
    } catch (err) {
      // The payout is booked; a bill leg nobody confirmed is the reconcile pass's to settle.
      if (!(err instanceof MoneyError)) throw err;
    }
  }
  const state = await db.withTenant(session.tenantId, (q) => readState(q, proposalId, false));
  return state ? resultOf(proposalId, state) : failed("not_found");
}

export function settlementApproveExecutor(money: SettlementMoneyDeps = {}): Executor {
  return async (db, session, proposal, _opts, deps: ExecuteDeps) => {
    const clock = deps.clock ?? (() => new Date());
    const startedMs = (money.nowMs ?? (() => Date.now()))();
    const now = clock();
    const phase = await db.withTenant(session.tenantId, (q) => prepare(q, proposal, now));
    if (phase.kind === "result") return phase.result;
    return payAndFinish(db, session, proposal.id, phase.step, money, clock, startedMs);
  };
}

export const executeSettlementApprove: Executor = settlementApproveExecutor();
