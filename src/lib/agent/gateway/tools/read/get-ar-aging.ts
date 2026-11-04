import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readAging, type AgingView } from "../../../../invoices/aging";
import { BUCKET_KEYS } from "../../../../reports/ar-aging";
import { AGING_BUCKETS, type AgingBucket } from "../../../../rules-engine";
import { localDateOf } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { dateField } from "../../validate";
import { OPERATOR } from "../shared";

// The buckets under names ending in Cents (currentCents, days1To30Cents and so on): the answer's
// figure check reads only keys ending in Cents, so a bucket total under "1_30" was withheld (Nov 4).
function inCents(buckets: Readonly<Record<AgingBucket, number>>): Record<string, number> {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [BUCKET_KEYS[b], buckets[b]]));
}

export function agingResult(view: AgingView) {
  return {
    asOf: view.asOf,
    totals: inCents(view.totals),
    totalCents: view.totalCents,
    rows: view.customers.map(({ buckets, ...row }) => ({ ...row, ...inCents(buckets) })),
  };
}

export const getArAging = defineTool({
  name: "get_ar_aging",
  description:
    "Age the carrier's open customer balances by days past due, as the rules engine buckets them " +
    "(currentCents, days1To30Cents, days31To60Cents, days61To90Cents, over90Cents), per customer " +
    "and in total, in integer cents. asOf defaults to today in the carrier's zone; minBucket " +
    "(current, 1_30, 31_60, 61_90 or over_90) keeps only customers with a balance in that bucket " +
    "or a later one. A past asOf still shows today's open balances (payments and invoices since " +
    "then included), only aged as of that date; it is not what was owed on that date. This only " +
    "reads.",
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
      result: agingResult(view),
    };
  },
});
