import type { PayoutDestination, ReadBack, SendContext } from "../adapters/types";
import { payoutReconcileHooks } from "../advances/approve";
import { expenseReconcileHooks } from "../advances/post-expense";
import type { TenantDb } from "../db";
import { invoiceReconcileHooks } from "../invoices/execute";
import { paymentReconcileHooks } from "../invoices/payments";
import {
  adapterReady,
  categoryOf,
  needsDestination,
  paymentFor,
  payoutOf,
  systemFor,
  withTimeout,
  type MoneyDeps,
} from "../money/execute";
import { switchOn } from "../money/ledger";
import type { ReconcileHooks } from "../money/reconcile";
import { KIND_SHAPES, railOf, type MoneyAction, type MoneyActionKind, type OutsideSystem } from "../money/types";
import type { ReadOutcome } from "../rules-engine/card-recon";
import { settlementReconcileHooks } from "../settlements/reconcile-hooks";

// The card check's read of one payment record from its own system: the card provider or the bank
// for a payout, QuickBooks for a post. Read only, always: it takes only the read-back and the
// destination read from each kind's reconcile hooks (never onConfirmed or onFailed), never moves
// a row, never sends. The read goes by the request id the send used, so it finds exactly the
// record that send made or nothing. A throw or a timeout is a category (an "unchecked" line),
// never an answer.

export type ReadHooks = {
  readBack?: ReconcileHooks["readBack"];
  destination?: ReconcileHooks["destination"];
};

const pick = (h: ReconcileHooks | undefined): ReadHooks | undefined =>
  h ? { readBack: h.readBack, destination: h.destination } : undefined;

// The read hooks by kind. A kind with none is not read: its rows are "not checked".
export function readHooks(db: TenantDb, tenantId: string, d: MoneyDeps): Partial<Record<MoneyActionKind, ReadHooks>> {
  const settlement = settlementReconcileHooks(db, tenantId, d.accounting);
  const out: Partial<Record<MoneyActionKind, ReadHooks | undefined>> = {
    advance_payout: pick(payoutReconcileHooks),
    advance_expense: pick(expenseReconcileHooks(db, tenantId, d)),
    settlement_payout: pick(settlement.settlement_payout),
    settlement_bill: pick(settlement.settlement_bill),
    settlement_bill_payment: pick(settlement.settlement_bill_payment),
    invoice: pick(invoiceReconcileHooks(db, tenantId, d.accounting)),
    customer_payment: pick(paymentReconcileHooks(db, tenantId, d.accounting)),
  };
  return out as Partial<Record<MoneyActionKind, ReadHooks>>;
}

// The key a system's readiness is asked once per slice by: each payout rail, and the books.
export function systemKey(kind: MoneyActionKind): string {
  return KIND_SHAPES[kind].channel === "payment" ? `payment:${railOf(kind)}` : "accounting";
}

// The system a row went to, or its kind's when the row has no answer yet. Null when neither can be
// told (a kind with no adapter here).
export function systemOf(action: MoneyAction, d: MoneyDeps): OutsideSystem | null {
  if (action.outsideSystem) return action.outsideSystem;
  try {
    return systemFor(action.kind, d);
  } catch {
    return null;
  }
}

// Whether a kind's system can be read now: its channel's switch on and its adapter ready.
export async function systemReady(
  db: TenantDb,
  tenantId: string,
  kind: MoneyActionKind,
  d: MoneyDeps,
): Promise<{ ok: true } | { ok: false; category: string }> {
  if (!switchOn(KIND_SHAPES[kind].channel)) return { ok: false, category: "disabled" };
  return adapterReady(db, tenantId, kind, d);
}

// One record read back, under its own time limit.
export async function readOneBack(
  db: TenantDb,
  tenantId: string,
  action: MoneyAction,
  hooks: ReadHooks | undefined,
  ctx: SendContext,
  d: MoneyDeps,
): Promise<ReadOutcome> {
  if (!hooks) return { ok: false, category: "no_reader" };
  let work: () => Promise<ReadBack>;
  if (KIND_SHAPES[action.kind].channel === "payment") {
    let payment;
    try {
      payment = paymentFor(action.kind, d);
    } catch (err) {
      return { ok: false, category: categoryOf(err) };
    }
    let destination: PayoutDestination | null = null;
    if (hooks.destination) {
      const read = hooks.destination;
      try {
        destination = await db.withTenant(tenantId, (q) => read(q, action));
      } catch (err) {
        return { ok: false, category: categoryOf(err) };
      }
      if (destination === null) return { ok: false, category: "validation" };
    } else if (needsDestination(payment)) {
      return { ok: false, category: "validation" };
    }
    let payout;
    try {
      payout = payoutOf(action, destination);
    } catch (err) {
      return { ok: false, category: categoryOf(err) };
    }
    const adapter = payment;
    work = () => adapter.readBack({ requestId: action.requestId, outsideId: action.outsideId, payout }, ctx);
  } else {
    const read = hooks.readBack;
    if (!read) return { ok: false, category: "no_reader" };
    work = () => read(action, ctx);
  }
  try {
    const rb = await withTimeout<ReadBack | null>(work, ctx.timeoutMs, () => null);
    if (rb === null) return { ok: false, category: "timeout" };
    if (rb?.found === false) return { ok: true, readBack: { found: false } };
    // A found record is compared whole: an amount that is not whole cents is no answer.
    if (rb?.found === true && Number.isSafeInteger(rb.amountCents) && rb.amountCents >= 0) {
      return { ok: true, readBack: rb };
    }
    return { ok: false, category: "unknown" };
  } catch (err) {
    return { ok: false, category: categoryOf(err) };
  }
}
