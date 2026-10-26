import { receivablesInputOf, settlementInputOf } from "../data/records";
import type { TenantRows } from "../data/rows";
import { TENANT_TABLES, type TenantTable } from "../data/tables";
import {
  ageReceivables,
  AGING_BUCKETS,
  agingBucket,
  invoiceStatus,
  settleDriver,
  type AgingBucket,
} from "../rules-engine";
import { isWithin, type Period } from "../time/local-date";
import type { CarrierPlan } from "./plan";

// The numbers that describe one seeded carrier, small enough to read in a review. golden.json is
// this summary for both carriers at anchor 2026-11-02; golden.test.ts rebuilds the plans and
// compares, and seed.db.test.ts compares the counts read back from the database.

export type HeroLine = { seq: number; kind: string; label: string; amountCents: number };

export type CarrierSummary = {
  counts: Record<TenantTable, number>;
  linehaulCents: number;
  hero: {
    code: string;
    lines: HeroLine[];
    grossCents: number;
    deductionsCents: number;
    netCents: number;
  } | null;
  // Net pay over all drivers, per settled week, oldest first.
  settledNetCents: { periodStart: string; netCents: number }[];
  advancesOutstandingCents: number;
  receivables: {
    openByBucket: Record<AgingBucket, { invoices: number; cents: number }>;
    paymentsInOpenWeek: number;
    overappliedInvoices: number;
  };
};

export function countRows(rows: TenantRows): Record<TenantTable, number> {
  return Object.fromEntries(TENANT_TABLES.map((t) => [t, rows[t].length])) as Record<
    TenantTable,
    number
  >;
}

export function summarizePlan(plan: CarrierPlan): CarrierSummary {
  const { rows, anchor, carrier } = plan;
  const openWeek: Period = plan.periods[3];

  let hero: CarrierSummary["hero"] = null;
  if (carrier.heroCode) {
    const driver = rows.drivers.find((d) => d.code === carrier.heroCode);
    if (!driver) throw new Error("the hero is missing");
    const r = settleDriver(settlementInputOf(rows, driver.id, openWeek));
    hero = {
      code: driver.code,
      lines: r.lines.map((l) => ({
        seq: l.seq,
        kind: l.kind,
        label: l.label,
        amountCents: l.amountCents,
      })),
      grossCents: r.grossCents,
      deductionsCents: r.deductionsCents,
      netCents: r.netCents,
    };
  }

  const settledNetCents = rows.settlement_periods
    .filter((p) => p.status === "paid")
    .sort((a, b) => (a.period_start < b.period_start ? -1 : 1))
    .map((p) => ({
      periodStart: p.period_start,
      netCents: rows.settlements
        .filter((s) => s.period_id === p.id)
        .reduce((n, s) => n + s.net_cents, 0),
    }));

  const advancesOutstandingCents = rows.advances
    .filter((a) => a.status === "approved" || a.status === "paid")
    .reduce((n, a) => n + a.amount_cents + a.fee_cents - a.recovered_cents, 0);

  const input = receivablesInputOf(rows, anchor);
  const aging = ageReceivables(input);
  const applied = new Map<string, number>();
  for (const a of rows.payment_applications) {
    applied.set(a.invoice_id, (applied.get(a.invoice_id) ?? 0) + a.amount_cents);
  }
  const openByBucket = Object.fromEntries(
    AGING_BUCKETS.map((b) => [b, { invoices: 0, cents: aging.totals[b] as number }]),
  ) as CarrierSummary["receivables"]["openByBucket"];
  let overappliedInvoices = 0;
  for (const i of rows.invoices) {
    if (i.status === "void") continue;
    const s = invoiceStatus(i.amount_cents, applied.get(i.id) ?? 0);
    if (s.overappliedCents > 0) overappliedInvoices++;
    if (s.balanceCents > 0) openByBucket[agingBucket(i.due_on, anchor)].invoices++;
  }

  return {
    counts: countRows(rows),
    linehaulCents: rows.loads.reduce((n, l) => n + (l.linehaul_cents ?? 0), 0),
    hero,
    settledNetCents,
    advancesOutstandingCents,
    receivables: {
      openByBucket,
      paymentsInOpenWeek: rows.customer_payments.filter((p) => isWithin(p.received_on, openWeek))
        .length,
      overappliedInvoices,
    },
  };
}
