import { flags } from "../../config/flags";
import { accountingAdapter } from "../adapters";
import type { AccountingAdapter, SendContext, SendOutcome } from "../adapters/types";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { executeMoneyAction, type MoneyDeps, type MoneyHooks } from "../money/execute";
import { readBySubject } from "../money/read";
import type { ReconcileHooks } from "../money/reconcile";
import { MAX_ATTEMPT, MoneyError, type MoneyAction } from "../money/types";
import type { ExecuteDeps } from "../proposals/execute";
import { assertMembership } from "../tenant/context";
import { expenseAmountCents } from "./request";
import { readFlowAdvance, type FlowAdvance } from "./rows";
import { advancesOn } from "./switches";

// The QuickBooks leg of a paid advance: one Purchase in the sandbox company, the advance and its
// fee as two lines (the accounting adapter's shape), dated the day it was requested and numbered
// with its reference. Its ledger row carries amount + fee (expenseAmountCents says why). It runs
// after a confirmed payout, in the approve request when time is left, or from the advance's page.
// The accounting switch is checked here, by the money executor at the write, and by the adapter.

export type PostDeps = ExecuteDeps & {
  money?: Partial<MoneyDeps>;
  // The approve request posts only a first attempt; a person's button may post again after a
  // definite failure.
  onlyFirst?: boolean;
};

export type PostResult =
  | { ok: true; advanceId: string; status: "posted" | "pending"; moneyActionId: string }
  | { ok: false; category: string; retryable: boolean };

type Vendor = { id: string; code: string; firstName: string; lastName: string; workerType: string };

class Stop extends Error {
  readonly result: { ok: false; category: string; retryable: boolean };
  constructor(category: string, retryable = false) {
    super(`advances: ${category}`);
    this.name = "Stop";
    this.result = { ok: false, category, retryable };
  }
}

const no = (category: string, retryable = false) => ({ ok: false as const, category, retryable });

async function readVendor(q: Queryable, driverId: string): Promise<Vendor> {
  const rows = await q.query<{
    id: string;
    code: string;
    first_name: string;
    last_name: string;
    worker_type: string;
  }>(
    `SELECT id, code, first_name, last_name, worker_type FROM drivers
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [driverId],
  );
  if (rows.length !== 1) throw new Stop("not_found");
  const r = rows[0];
  return { id: r.id, code: r.code, firstName: r.first_name, lastName: r.last_name, workerType: r.worker_type };
}

function accountingOf(money: Partial<MoneyDeps> | undefined): AccountingAdapter {
  return money?.accounting ?? accountingAdapter();
}

// The one outside call: the driver's vendor record, then the purchase, in the tenant's
// transaction (the adapter keeps its connection and id map there).
function sendHook(
  db: TenantDb,
  tenantId: string,
  accounting: AccountingAdapter,
  advance: FlowAdvance,
  vendor: Vendor,
): NonNullable<MoneyHooks["send"]> {
  return (action: MoneyAction, ctx: SendContext): Promise<SendOutcome> =>
    db.withTenant(tenantId, async (q) => {
      const v = await accounting.ensureVendor(q, vendor, ctx);
      return accounting.createExpense(
        q,
        {
          actionId: action.id,
          vendorOutsideId: v.outsideId,
          amountCents: advance.amountCents,
          feeCents: advance.feeCents,
          onDate: advance.requestedOn,
          docRef: advance.requestRef,
        },
        ctx,
      );
    });
}

// The post changes no domain row: posting state is read from the ledger. The reserve already
// checked the advance is paid; this asks again in the same transaction and throws if not.
async function onExpenseReserved(q: Queryable, action: MoneyAction): Promise<void> {
  const rows = await q.query<{ status: string }>(
    `SELECT status FROM advances
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND proposal_id IS NOT NULL`,
    [action.subjectId],
  );
  if (rows.length !== 1 || rows[0].status !== "paid") throw new MoneyError("validation");
}

// The reconcile pass's read-back for a post left unknown, by its id or document number.
export function expenseReconcileHooks(
  db: TenantDb,
  tenantId: string,
  money: Partial<MoneyDeps> | undefined,
): ReconcileHooks {
  const accounting = accountingOf(money);
  return {
    onConfirmed: async () => {},
    readBack: (action, ctx) =>
      db.withTenant(tenantId, (q) =>
        accounting.readBack(
          q,
          {
            type: action.outsideType ?? "Purchase",
            requestId: action.requestId,
            outsideId: action.outsideId,
            outsideRef: action.outsideRef,
          },
          ctx,
        ),
      ),
  };
}

export async function postAdvanceExpense(
  session: Session,
  advanceId: string,
  deps: PostDeps = {},
): Promise<PostResult> {
  if (!advancesOn()) return no("disabled");
  if (flags.accountingEnabled !== true) return no("accounting_off");
  const db = deps.db ?? getDb();
  let picked: { advance: FlowAdvance; vendor: Vendor; attempt: number };
  try {
    picked = await db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      const advance = await readFlowAdvance(q, advanceId);
      if (!advance) throw new Stop("not_found");
      if (advance.status !== "paid") throw new Stop("not_paid");
      const rows = (await readBySubject(q, "advances", advance.id)).filter(
        (a) => a.kind === "advance_expense",
      );
      const latest = rows.at(-1) ?? null;
      let attempt = 1;
      if (latest) {
        if (latest.state === "confirmed") throw new Stop("already_posted");
        if (latest.state !== "failed") throw new Stop("post_pending");
        if (latest.failureCategory === "amount_mismatch") throw new Stop("not_retryable");
        if (deps.onlyFirst) throw new Stop("post_failed", true);
        attempt = latest.attempt + 1;
      }
      if (attempt > flags.advancesLimits.maxPayoutAttempts || attempt > MAX_ATTEMPT) {
        throw new Stop("attempts_exhausted");
      }
      return { advance, vendor: await readVendor(q, advance.driverId), attempt };
    });
  } catch (err) {
    if (err instanceof Stop) return err.result;
    throw err;
  }
  const { advance, vendor, attempt } = picked;
  try {
    const r = await executeMoneyAction(
      db,
      session,
      {
        kind: "advance_expense",
        subjectId: advance.id,
        counterpartyId: advance.driverId,
        amountCents: expenseAmountCents(advance),
        attempt,
        proposedBy: "agent",
        proposalId: advance.proposalId,
        traceId: null,
        subjectStatuses: ["paid"],
      },
      {
        onReserved: onExpenseReserved,
        send: sendHook(db, session.tenantId, accountingOf(deps.money), advance, vendor),
      },
      deps.money,
    );
    if (r.action.state === "confirmed") {
      return { ok: true, advanceId: advance.id, status: "posted", moneyActionId: r.action.id };
    }
    if (r.action.state === "failed") return no("post_failed", r.action.failureCategory !== "amount_mismatch");
    return { ok: true, advanceId: advance.id, status: "pending", moneyActionId: r.action.id };
  } catch (err) {
    if (err instanceof MoneyError) {
      if (err.category === "disabled") return no("accounting_off");
      if (err.category === "validation" || err.category === "duplicate") return no("unavailable");
      // The send happened and even the read of its row failed: the purchase may exist, so the
      // outcome is unknown (Check pending reads it back), never "nothing was written". An adapter
      // not ready for a reason it cannot name lands here too; pending is the safe side of that.
      if (err.category === "unknown") return no("post_pending");
      return no("unavailable", true);
    }
    if (err instanceof Error && err.name === "ForbiddenError") throw err;
    console.error("advance post did not finish:", err instanceof Error ? err.name : "unknown");
    // Not always before a send: a read of the row can fail while this request waits on another
    // that holds the send, so the purchase may exist. Unknown, never "nothing was written".
    return no("post_pending");
  }
}
