import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readPaymentsBetween, type PaymentsView } from "../../../../invoices/aging";
import { daysBetween } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { dateField } from "../../validate";
import { OPERATOR } from "../shared";

// The longest range one call reads, in days, both ends included.
export const PAYMENTS_IN_MAX_DAYS = 92;

// Each method's total under a name ending in Cents: the answer's figure check reads only keys
// ending in Cents, so a total under "check" was withheld.
export function paymentsResult(view: PaymentsView) {
  return {
    from: view.from,
    to: view.to,
    totalsByMethod: {
      checkCents: view.totalsByMethod.check,
      achCents: view.totalsByMethod.ach,
      wireCents: view.totalsByMethod.wire,
    },
    totalCents: view.totalCents,
    rows: view.payments,
  };
}

export const getPaymentsIn = defineTool({
  name: "get_payments_in",
  description:
    "List customer payments received from one date to another (both included, at most 92 days), " +
    "each with the invoices it was applied to and what is left unapplied, plus totals by method, " +
    "in integer cents. This only reads.",
  tier: "read",
  roles: OPERATOR,
  label: "Reading payments received",
  enabled: () => flags.customerPaymentsEnabled,
  args: z
    .strictObject({ from: dateField(), to: dateField() })
    .refine((a) => a.to >= a.from && daysBetween(a.from, a.to) < PAYMENTS_IN_MAX_DAYS, {
      path: ["to"],
      message: "the range must run forward and cover at most 92 days",
    }),
  refs: (): GatewayRef[] => [],
  run: async (q, _ctx, a) => {
    if (!flags.customerPaymentsEnabled) throw new Error("customer payments is switched off");
    return { result: paymentsResult(await readPaymentsBetween(q, a.from, a.to)) };
  },
});
