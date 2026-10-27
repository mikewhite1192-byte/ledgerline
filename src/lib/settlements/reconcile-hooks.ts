import { accountingAdapter } from "../adapters";
import type { TenantDb } from "../db";
import type { MoneyDeps } from "../money/execute";
import type { ReconcileHooks } from "../money/reconcile";
import type { MoneyActionKind } from "../money/types";
import { payoutHooks } from "./legs";

// What the reconcile pass does when it settles a settlement leg nobody confirmed at send time
// (a timeout, a lost reply). The payout's confirmation commits on its own, as it does at send time:
// the paystub is booked after, in its own transaction (bookConfirmedPayout in legs.ts), by the next
// approve resume, batch drain or Retry booking, so a booking error never leaves money that went out
// unrecorded. A failure ends the card failed. The bill legs only record what the accounting system
// holds, read back by the request id the send used (or the outside id when the reply was kept).

const noop = async () => {};

export function settlementReconcileHooks(
  db: TenantDb,
  tenantId: string,
  accounting: MoneyDeps["accounting"] = accountingAdapter(),
  clock: () => Date = () => new Date(),
): Partial<Record<MoneyActionKind, ReconcileHooks>> {
  const readBackAs =
    (type: "Bill" | "BillPayment"): NonNullable<ReconcileHooks["readBack"]> =>
    (action, ctx) =>
      db.withTenant(tenantId, (q) =>
        accounting.readBack(
          q,
          { type, requestId: action.requestId, outsideId: action.outsideId, outsideRef: action.outsideRef },
          ctx,
        ),
      );
  return {
    settlement_payout: {
      onConfirmed: noop,
      onFailed: (q, action) => payoutHooks(action.subjectId, clock).onFailed(q, action),
    },
    settlement_bill: { onConfirmed: noop, readBack: readBackAs("Bill") },
    settlement_bill_payment: { onConfirmed: noop, readBack: readBackAs("BillPayment") },
  };
}
