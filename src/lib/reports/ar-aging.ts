import {
  ageReceivables,
  AGING_BUCKETS,
  sum,
  type AgingBucket,
  type CustomerRecord,
  type ReceivablesInput,
} from "../rules-engine";
import { byId, byLargest, mustGet, reportOf } from "./build";
import type { ReportResult, ReportRow } from "./types";

// What each customer owes and how late, from the engine's own aging (ageReceivables): today's
// open balances of invoices that are not void, by days past due as of a carrier-local date. A
// past date is not the position on that date: every payment applied since and every invoice
// issued since still count, so the chat's caption and the tool's description say exactly that.
// Each row and the totals also carry past60Cents (61 to 90 plus over 90), summed here in integer
// cents, so a "past 60 days" answer quotes a record figure instead of adding two buckets itself.
// It is not a column: the table and the CSV show the buckets only.

// Each bucket's name ending in Cents, here and in get_ar_aging's result, so a figure quoted from
// either one is read as a record figure by the answer's check.
export const BUCKET_KEYS: Readonly<Record<AgingBucket, string>> = {
  current: "currentCents",
  "1_30": "days1To30Cents",
  "31_60": "days31To60Cents",
  "61_90": "days61To90Cents",
  over_90: "over90Cents",
};

// What is more than 60 days past due: the 61 to 90 bucket plus the over 90 bucket.
function past60(buckets: Readonly<Record<AgingBucket, number>>): number {
  return sum([buckets["61_90"], buckets.over_90]);
}

export type ArAgingInput = { receivables: ReceivablesInput; customers: readonly CustomerRecord[] };

export function computeArAging(input: ArAgingInput): ReportResult {
  const aging = ageReceivables(input.receivables);
  const customers = byId(input.customers, "customers");
  const rows: ReportRow[] = aging.byCustomer.map(({ customerId, buckets }) => {
    const customer = mustGet(customers, customerId, "customer");
    const row: ReportRow = { customer: { table: "customers", id: customer.id, label: customer.name } };
    for (const b of AGING_BUCKETS) row[BUCKET_KEYS[b]] = buckets[b];
    row.past60Cents = past60(buckets);
    row.totalCents = sum(AGING_BUCKETS.map((b) => buckets[b]));
    return row;
  });
  rows.sort(byLargest("totalCents", "customer"));
  const totals: Record<string, number> = {};
  for (const b of AGING_BUCKETS) totals[BUCKET_KEYS[b]] = aging.totals[b];
  totals.past60Cents = past60(aging.totals);
  totals.totalCents = sum(AGING_BUCKETS.map((b) => aging.totals[b]));
  const asOf = input.receivables.asOf;
  return reportOf("ar_aging", { asOf, args: { asOf }, rows, totals });
}
