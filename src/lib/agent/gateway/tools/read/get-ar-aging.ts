import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readAging } from "../../../../invoices/aging";
import { AGING_BUCKETS } from "../../../../rules-engine";
import { localDateOf } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { dateField } from "../../validate";
import { OPERATOR } from "../shared";

export const getArAging = defineTool({
  name: "get_ar_aging",
  description:
    "Age the carrier's open customer balances by days past due, as the rules engine buckets them " +
    "(current, 1_30, 31_60, 61_90, over_90), per customer and in total, in integer cents. asOf " +
    "defaults to today in the carrier's zone; minBucket keeps only customers with a balance in " +
    "that bucket or a later one. This only reads.",
  tier: "read",
  roles: OPERATOR,
  label: "Aging the receivables",
  enabled: () => flags.customerPaymentsEnabled,
  args: z.strictObject({
    asOf: dateField().optional(),
    minBucket: z.enum(AGING_BUCKETS).optional(),
  }),
  refs: (): GatewayRef[] => [],
  run: async (q, ctx, a) => {
    if (!flags.customerPaymentsEnabled) throw new Error("customer payments is switched off");
    const asOf = a.asOf ?? localDateOf(ctx.now.toISOString(), ctx.timeZone);
    const view = await readAging(q, asOf, a.minBucket);
    return {
      result: { asOf: view.asOf, totals: view.totals, totalCents: view.totalCents, rows: view.customers },
    };
  },
});
