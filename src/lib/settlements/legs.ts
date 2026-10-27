import { accountingAdapter } from "../adapters";
import type { PayLine as AdapterPayLine } from "../adapters/types";
import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import { readRowsWhereId, readTenant } from "../data/read";
import { executeMoneyAction, type ExecuteResult, type MoneyDeps, type MoneyHooks } from "../money/execute";
import { settle } from "../money/ledger";
import { readBySubject } from "../money/read";
import { MoneyError, type MoneyAction, type MoneyDraft } from "../money/types";
import type { PayLine } from "../rules-engine";
import { localDateOf, type LocalDate } from "../time/local-date";
import { bookPaidSettlement } from "./book";
import {
  readPeriod,
  readStoredLines,
  readStoredSettlement,
  recheckSettlement,
  type StoredSettlement,
} from "./stored";

// The three money legs of one approved paystub, in order: the payout to the driver (payment
// channel), the bill for the week (accounting), and the bill payment that marks it paid. Every leg
// goes through the money executor with the settlement's ledger key (<kind>:<settlement id>:
// <attempt>), so the same leg is sent at most once per attempt, by whoever gets there first (the
// approve, the batch drain, or a button). Once the payout is confirmed and that record committed,
// the paystub is booked as paid in its own transaction (bookConfirmedPayout), so a booking error
// never undoes the record of money that went out; a booking that does not go through stops the
// legs after it, as a failed leg does, and Retry books it without sending again. The bill legs only
// record what the accounting system holds. A later leg never starts until the leg before it is
// confirmed and the paystub is booked.

export const LEG_KINDS = ["settlement_payout", "settlement_bill", "settlement_bill_payment"] as const;
export type LegKind = (typeof LEG_KINDS)[number];

export type SettlementMoneyDeps = Partial<MoneyDeps> & {
  // The request clock in milliseconds, for budgets only (never a date). Tests inject it.
  nowMs?: () => number;
};

// Everything a leg sends, read inside a tenant transaction from the stored settlement.
export type LegParty = {
  settlementId: string;
  periodId: string;
  status: "draft" | "approved" | "paid";
  netCents: number;
  paidAt: string | null;
  timezone: string;
  periodEnd: LocalDate;
  driver: { id: string; code: string; firstName: string; lastName: string; workerType: string };
  lines: PayLine[];
};

export async function readLegParty(q: Queryable, settlementId: string): Promise<LegParty | null> {
  const stored = await readStoredSettlement(q, settlementId, false);
  if (!stored) return null;
  const [driver] = await readRowsWhereId(q, "drivers", "id", stored.driverId);
  const period = await readPeriod(q, stored.periodId);
  const tenant = await readTenant(q);
  if (!driver || !period || !tenant) return null;
  return {
    settlementId: stored.id,
    periodId: stored.periodId,
    status: stored.status,
    netCents: stored.netCents,
    paidAt: stored.paidAt,
    timezone: tenant.timezone,
    periodEnd: period.end,
    driver: {
      id: driver.id,
      code: driver.code,
      firstName: driver.first_name,
      lastName: driver.last_name,
      workerType: driver.worker_type,
    },
    lines: await readStoredLines(q, settlementId),
  };
}

export type LegOptions = { attempt: number; proposalId: string | null; batchId: string | null };

const STATUSES: Readonly<Record<LegKind, readonly string[]>> = {
  // The payout starts only from an approved paystub; a paid one is never paid again.
  settlement_payout: ["approved"],
  // The bill legs follow the payout, so the paystub is paid by then (approved on a replay).
  settlement_bill: ["approved", "paid"],
  settlement_bill_payment: ["approved", "paid"],
};

export function legDraft(
  kind: LegKind,
  party: { settlementId: string; driverId: string; netCents: number },
  opts: LegOptions,
): MoneyDraft {
  return {
    kind,
    subjectId: party.settlementId,
    counterpartyId: party.driverId,
    amountCents: party.netCents,
    attempt: opts.attempt,
    proposedBy: "person",
    proposalId: opts.proposalId,
    subjectStatuses: STATUSES[kind],
    batchId: opts.batchId,
  };
}

// The waiting settlement_approve card moved on by the payout's outcome. Conditional on its status,
// so a second caller (the drain, the reconcile pass) changes nothing.
export async function linkProposal(q: Queryable, settlementId: string, actionId: string, now: Date): Promise<void> {
  await q.execute(
    `UPDATE proposals SET money_action_id = CAST($2 AS uuid), updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND kind = 'settlement_approve'
        AND subject_id = CAST($1 AS uuid) AND status IN ('approved', 'executing')
        AND money_action_id IS NULL`,
    [settlementId, actionId, now.toISOString()],
  );
}

export async function finishProposal(
  q: Queryable,
  settlementId: string,
  to: "done" | "failed",
  note: string | null,
  now: Date,
): Promise<void> {
  await q.execute(
    `UPDATE proposals SET status = $2, decision_note = $3, updated_at = CAST($4 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND kind = 'settlement_approve'
        AND subject_id = CAST($1 AS uuid) AND status = 'executing'`,
    [settlementId, to, note, now.toISOString()],
  );
}

// The card a paystub shows: its live card, else its newest (views.ts and list.ts pick it the same
// way). $1 is the settlement id.
const SHOWN_CARD = `SELECT id FROM proposals
  WHERE tenant_id = current_tenant_id() AND kind = 'settlement_approve' AND subject_id = CAST($1 AS uuid)
  ORDER BY (status IN ('proposed', 'approved', 'executing')) DESC, created_at DESC, id
  LIMIT 1`;

// The paystub's card once its payout is booked. An executing card ends done. A card that had
// already ended (failed when a payout was refused before a retry sent it, or done 'not_paid' when
// the switch was off at the approve) keeps its status, which 0014's guard makes final, and loses
// the note that no longer holds.
export async function cardPaid(q: Queryable, settlementId: string, now: Date): Promise<void> {
  await finishProposal(q, settlementId, "done", null, now);
  await q.execute(
    `UPDATE proposals SET decision_note = NULL, updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = (${SHOWN_CARD})
        AND status IN ('done', 'failed') AND decision_note IS NOT NULL`,
    [settlementId, now.toISOString()],
  );
}

// Why the paystub's payout did not finish, on the card it shows. An executing card moves to
// executingTo ('failed' ends it; 'executing' keeps it running, for a step still to retry); a card
// that already ended keeps its status and carries the note.
async function cardNote(
  q: Queryable,
  settlementId: string,
  note: string,
  executingTo: "failed" | "executing",
  now: Date,
): Promise<void> {
  await q.execute(
    `UPDATE proposals
        SET status = CASE WHEN status = 'executing' THEN CAST($2 AS text) ELSE status END,
            decision_note = $3, updated_at = CAST($4 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = (${SHOWN_CARD})
        AND status IN ('executing', 'failed', 'done')`,
    [settlementId, executingTo, note, now.toISOString()],
  );
}

// The payout's follow-up writes in its settle transaction, shared by the executor, the batch and
// the reconcile pass. A confirmation writes nothing here: the booking runs after the settle
// commits (bookConfirmedPayout).
export function payoutHooks(settlementId: string, clock: () => Date): Required<Pick<MoneyHooks, "onReserved" | "onFailed">> {
  return {
    onReserved: (q, action) => linkProposal(q, settlementId, action.id, clock()),
    onFailed: (q, action) => finishProposal(q, settlementId, "failed", action.failureCategory ?? "unknown", clock()),
  };
}

export type BookOutcome = "booked" | "not_confirmed" | "not_booked";

// The paystub booked as paid once its payout is confirmed, in its own transaction after the
// payout's record committed, and its card ended. booked: now or earlier. not_confirmed: no
// confirmed payout behind an approved paystub, so nothing was written. not_booked: the booking
// failed and rolled back whole; the payout stays confirmed, the card says so (and stays executing
// when it was), and the next approve resume, batch drain or Retry books it, never sending again.
export async function bookConfirmedPayout(
  db: TenantDb,
  tenantId: string,
  settlementId: string,
  clock: () => Date,
): Promise<BookOutcome> {
  try {
    return await db.withTenant(tenantId, async (q) => {
      // The paystub's lock first, the order every writer of it uses.
      const stored = await readStoredSettlement(q, settlementId, true);
      const now = clock();
      if (stored?.status === "paid") {
        await cardPaid(q, settlementId, now);
        return "booked";
      }
      if (stored?.status !== "approved") return "not_confirmed";
      const payout = latestOf(await readBySubject(q, "settlements", settlementId), "settlement_payout");
      if (payout?.state !== "confirmed") return "not_confirmed";
      await bookPaidSettlement(q, settlementId, now);
      await cardPaid(q, settlementId, now);
      return "booked";
    });
  } catch (err) {
    console.error(
      `settlements: booking settlement ${settlementId} did not commit (${err instanceof Error ? err.name : "unknown"})`,
    );
  }
  try {
    await db.withTenant(tenantId, async (q) => {
      // Only while the paystub is still unbooked: a commit whose answer was lost may have booked it.
      const stored = await readStoredSettlement(q, settlementId, true);
      if (stored?.status === "approved") await cardNote(q, settlementId, "not_booked", "executing", clock());
    });
  } catch (err) {
    // The record page offers Retry booking from the paystub and its ledger rows alone.
    console.error(`settlements: noting the unbooked settlement ${settlementId} failed (${err instanceof Error ? err.name : "unknown"})`);
  }
  return "not_booked";
}

// The pre-pay recheck on an approved paystub, the one the approve runs on the draft, run again
// before a payout goes from the batch drain, Retry payout or a resumed approve. The caller holds
// the paystub's lock. An approved paystub cannot be parked (only a draft can), so a stale one is
// refused instead: a reserved payout settles as refused before any call (validation, as the drain
// refuses), an executing card ends failed 'records_changed' (an ended one carries that note), and
// nothing is sent. A payout already sent, unknown or confirmed is never refused here. true when it
// refused.
export async function refuseStalePayout(q: Queryable, stored: StoredSettlement, now: Date): Promise<boolean> {
  if (stored.status !== "approved") return false;
  const payout = latestOf(await readBySubject(q, "settlements", stored.id), "settlement_payout");
  if (payout !== null && payout.state !== "reserved" && payout.state !== "failed") return false;
  const check = await recheckSettlement(q, stored, await readStoredLines(q, stored.id));
  if (check.park === null) return false;
  // A row another caller claimed a moment ago is its send now (checked before it claimed).
  if (payout?.state === "reserved" && !(await settle(q, payout.id, { to: "failed", via: "refused", category: "validation" }))) {
    return false;
  }
  await cardNote(q, stored.id, "records_changed", "failed", now);
  console.info(`settlements: payout refused, records changed (${check.park}) for settlement ${stored.id}`);
  return true;
}

// The bill's lines are the stored paystub lines, and must add up to the net exactly.
export function billLines(lines: readonly PayLine[], netCents: number): AdapterPayLine[] | null {
  const out = lines.map((l) => ({ kind: l.kind, description: l.label, amountCents: l.amountCents as number }));
  const total = out.reduce((s, l) => s + l.amountCents, 0);
  return total === netCents ? out : null;
}

// The confirmed bill's outside id (the latest confirmed attempt), or null.
export function confirmedBill(rows: readonly MoneyAction[]): MoneyAction | null {
  const bills = rows.filter((a) => a.kind === "settlement_bill" && a.state === "confirmed" && a.outsideId);
  return bills.reduce<MoneyAction | null>((top, a) => (top === null || a.attempt > top.attempt ? a : top), null);
}

const noop = async () => {};

// The accounting legs' hooks. Each send makes its vendor first (no bill was sent when that fails)
// and then the one document. Each adapter call runs in its own short tenant transaction.
export function accountingHooks(
  db: TenantDb,
  tenantId: string,
  kind: Exclude<LegKind, "settlement_payout">,
  accounting: MoneyDeps["accounting"],
): MoneyHooks {
  return {
    onReserved: noop,
    send: async (action, ctx) => {
      const party = await db.withTenant(tenantId, (q) => readLegParty(q, action.subjectId));
      if (!party) return { kind: "failed", category: "validation" };
      let vendorOutsideId: string;
      try {
        vendorOutsideId = (await db.withTenant(tenantId, (q) => accounting.ensureVendor(q, party.driver, ctx)))
          .outsideId;
      } catch (err) {
        return { kind: "failed", category: err instanceof MoneyError ? err.category : "unknown" };
      }
      if (kind === "settlement_bill") {
        const lines = billLines(party.lines, action.amountCents);
        if (!lines) return { kind: "failed", category: "validation" };
        return db.withTenant(tenantId, (q) =>
          accounting.createBill(
            q,
            {
              actionId: action.id,
              vendorOutsideId,
              driverCode: party.driver.code,
              periodEnd: party.periodEnd,
              lines,
            },
            ctx,
          ),
        );
      }
      const bill = confirmedBill(await db.withTenant(tenantId, (q) => readBySubject(q, "settlements", action.subjectId)));
      if (!bill?.outsideId || !party.paidAt) return { kind: "failed", category: "not_configured" };
      const paidOn = localDateOf(party.paidAt, party.timezone);
      return db.withTenant(tenantId, (q) =>
        accounting.payBill(
          q,
          {
            actionId: action.id,
            billOutsideId: bill.outsideId as string,
            vendorOutsideId,
            amountCents: action.amountCents,
            paidOn,
          },
          ctx,
        ),
      );
    },
  };
}

// One leg through the money executor. Throws MoneyError before any write when the leg's switch is
// off or its adapter is not ready.
export async function sendLeg(
  db: TenantDb,
  session: Session,
  kind: LegKind,
  party: { settlementId: string; driverId: string; netCents: number },
  opts: LegOptions,
  money: SettlementMoneyDeps,
  clock: () => Date,
): Promise<ExecuteResult> {
  const { nowMs: _nowMs, ...deps } = money;
  void _nowMs;
  const accounting = deps.accounting ?? accountingAdapter();
  const hooks =
    kind === "settlement_payout"
      ? payoutHooks(party.settlementId, clock)
      : accountingHooks(db, session.tenantId, kind, accounting);
  return executeMoneyAction(db, session, legDraft(kind, party, opts), hooks, { ...deps, accounting });
}

// Where a leg stands from its ledger rows: the attempt to send (a new row, or a replay of one in
// flight), or why not. A failed leg is retried as attempt + 1 only when asked (a person's button),
// at most settlementLimits.maxPayoutAttempts times; an unknown one waits for the reconcile pass.
export type LegPlan =
  | { go: true; attempt: number }
  | { go: false; state: "confirmed" | "failed" | "unknown" | "attempts_used" };

export function latestOf(rows: readonly MoneyAction[], kind: LegKind): MoneyAction | null {
  return rows
    .filter((a) => a.kind === kind)
    .reduce<MoneyAction | null>((top, a) => (top === null || a.attempt > top.attempt ? a : top), null);
}

export function planLeg(rows: readonly MoneyAction[], kind: LegKind, retryFailed: boolean): LegPlan {
  const latest = latestOf(rows, kind);
  if (latest === null) return { go: true, attempt: 1 };
  if (latest.state === "confirmed") return { go: false, state: "confirmed" };
  if (latest.state === "unknown") return { go: false, state: "unknown" };
  if (latest.state === "failed") {
    if (!retryFailed) return { go: false, state: "failed" };
    const next = latest.attempt + 1;
    if (next > flags.settlementLimits.maxPayoutAttempts) return { go: false, state: "attempts_used" };
    return { go: true, attempt: next };
  }
  return { go: true, attempt: latest.attempt };
}

export type LegsOutcome = {
  bill: string;
  billPayment: string;
};

// Legs 2 and 3 for a paid paystub: the bill, then (only once the bill is confirmed) its payment.
// Stops at the first leg that is not confirmed. A MoneyError on a leg is reported as that leg's
// state (disabled, not_connected, ...); an unknown outcome is rethrown for the caller to report.
export async function runAccountingLegs(
  db: TenantDb,
  session: Session,
  settlementId: string,
  opts: { proposalId: string | null; batchId: string | null; retryFailed: boolean },
  money: SettlementMoneyDeps,
  clock: () => Date,
): Promise<LegsOutcome> {
  const tenantId = session.tenantId;
  const out: LegsOutcome = { bill: "not_started", billPayment: "not_started" };
  for (const kind of ["settlement_bill", "settlement_bill_payment"] as const) {
    const read = await db.withTenant(tenantId, async (q) => {
      const party = await readLegParty(q, settlementId);
      const rows = await readBySubject(q, "settlements", settlementId);
      return { party, rows };
    });
    if (!read.party || read.party.status !== "paid") return out;
    if (kind === "settlement_bill_payment" && !confirmedBill(read.rows)) return out;
    const plan = planLeg(read.rows, kind, opts.retryFailed);
    const key = kind === "settlement_bill" ? "bill" : "billPayment";
    if (!plan.go) {
      out[key] = plan.state;
      if (plan.state !== "confirmed") return out;
      continue;
    }
    let result: ExecuteResult;
    try {
      result = await sendLeg(
        db,
        session,
        kind,
        { settlementId, driverId: read.party.driver.id, netCents: read.party.netCents },
        { attempt: plan.attempt, proposalId: opts.proposalId, batchId: opts.batchId },
        money,
        clock,
      );
    } catch (err) {
      if (!(err instanceof MoneyError) || err.category === "unknown") throw err;
      out[key] = err.category;
      return out;
    }
    out[key] = result.action.state;
    if (result.action.state !== "confirmed") return out;
  }
  return out;
}
