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

// What each customer owes and how late, from the engine's own aging (ageReceivables): open
// balances of invoices that are not void, by days past due as of a carrier-local date.

const BUCKET_KEYS: Readonly<Record<AgingBucket, string>> = {
  current: "currentCents",
  "1_30": "days1To30Cents",
  "31_60": "days31To60Cents",
  "61_90": "days61To90Cents",
  over_90: "over90Cents",
};

export type ArAgingInput = { receivables: ReceivablesInput; customers: readonly CustomerRecord[] };

export function computeArAging(input: ArAgingInput): ReportResult {
  const aging = ageReceivables(input.receivables);
  const customers = byId(input.customers, "customers");
  const rows: ReportRow[] = aging.byCustomer.map(({ customerId, buckets }) => {
    const customer = mustGet(customers, customerId, "customer");
    const row: ReportRow = { customer: { table: "customers", id: customer.id, label: customer.name } };
    for (const b of AGING_BUCKETS) row[BUCKET_KEYS[b]] = buckets[b];
    row.totalCents = sum(AGING_BUCKETS.map((b) => buckets[b]));
    return row;
  });
  rows.sort(byLargest("totalCents", "customer"));
  const totals: Record<string, number> = {};
  for (const b of AGING_BUCKETS) totals[BUCKET_KEYS[b]] = aging.totals[b];
  totals.totalCents = sum(AGING_BUCKETS.map((b) => aging.totals[b]));
  const asOf = input.receivables.asOf;
  return reportOf("ar_aging", { asOf, args: { asOf }, rows, totals });
}
