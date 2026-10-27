import { z } from "zod";
import { readPaymentsBetween } from "../../../../invoices/aging";
import { daysBetween } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { dateField } from "../../validate";
import { OPERATOR } from "../shared";

// The longest range one call reads, in days, both ends included.
export const PAYMENTS_IN_MAX_DAYS = 92;

export const getPaymentsIn = defineTool({
  name: "get_payments_in",
  description:
    "List customer payments received from one date to another (both included, at most 92 days), " +
    "each with the invoices it was applied to and what is left unapplied, plus totals by method, " +
    "in integer cents. This only reads.",
  tier: "read",
  roles: OPERATOR,
  label: "Reading payments received",
  args: z
    .strictObject({ from: dateField(), to: dateField() })
    .refine((a) => a.to >= a.from && daysBetween(a.from, a.to) < PAYMENTS_IN_MAX_DAYS, {
      path: ["to"],
      message: "the range must run forward and cover at most 92 days",
    }),
  refs: (): GatewayRef[] => [],
  run: async (q, _ctx, a) => {
    const view = await readPaymentsBetween(q, a.from, a.to);
    return {
      result: {
        from: view.from,
        to: view.to,
        totalsByMethod: view.totalsByMethod,
        totalCents: view.totalCents,
        rows: view.payments,
      },
    };
  },
});
