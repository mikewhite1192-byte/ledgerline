import { flags } from "../../config/flags";
import { sortVersions } from "../data/config-version";
import { customerOf, loadStopsOf, receivablesInputOf, settlementInputOf } from "../data/records";
import type { TenantRows } from "../data/rows";
import { TENANT_TABLES, type TenantTable } from "../data/tables";
import {
  ageReceivables,
  AGING_BUCKETS,
  agingBucket,
  findUnbilledDetention,
  invoiceStatus,
  lastFullMonthBefore,
  settleDriver,
  sum,
  type AgingBucket,
} from "../rules-engine";
import { daysBetween, isWithin, type Period } from "../time/local-date";
import type { CustomerClass } from "./ar-plan";
import { fuelAnomalyIds } from "./assert-plan";
import { cashPositionOf } from "./cash-plan";
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
  // The pay rules versions, oldest first, and the settled weeks each one ran.
  payConfigVersions: {
    effectiveFrom: string;
    note: string | null;
    source: string;
    insurancePerDayCents: number;
    settledPeriods: string[];
  }[];
  fuelAnomalies: {
    rule: string;
    purchaseRef: string;
    driverCode: string;
    state: string;
    gallonsMilli: number;
    amountCents: number;
  }[];
  // Unbilled detention over the last full month before the anchor (the demo's dollar line).
  detention: {
    window: Period;
    loads: { loadNumber: string; stop: string; overMinutes: number; cents: number }[];
    totalCents: number;
  };
  collections: {
    customerCode: string;
    class: CustomerClass;
    invoiceNumber: string;
    daysLate: number;
    balanceCents: number;
  }[];
  // The invoice review plants by the status each is planted to show, and the two customers that
  // require a signed delivery document.
  invoiceReview: {
    podCustomers: string[];
    plants: { plant: string; invoiceNumber: string; customerCode: string; amountCents: number }[];
  };
  // The card provider's statement plants, and the driver the unknown card's candidates put on top
  // (null: a tie a person resolves).
  cardRecon: {
    planted: Record<
      "fuelAmountDiffers" | "purchaseNotRecorded" | "cardUnknown" | "loadNotInLedger",
      { postedOn: string; last4: string; amountCents: number; state: string | null }
    >;
    candidateDriverCode: string | null;
  };
  // The Cash page's first check at the anchor (design 4.9): the figures, and how many invoices
  // the factoring card names and how many customers the chase cards name (none when covered).
  cashFriday: {
    payDay: string;
    bankBalanceCents: number;
    cashOnHandCents: number;
    expectedReceiptsCents: number;
    payRunCents: number;
    payRunSource: string;
    fuelLoadsCents: number;
    vendorBillsDueCents: number;
    gapCents: number;
    factoringInvoices: number;
    factoringNetCents: number;
    deferBillRef: string | null;
    chaseCustomers: number;
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

  // As the engine counts it (outstandingCents): an amount taken back is no longer owed.
  const advancesOutstandingCents = rows.advances
    .filter((a) => a.status === "approved" || a.status === "paid")
    .reduce((n, a) => n + Math.max(0, a.amount_cents + a.fee_cents - a.recovered_cents - a.taken_back_cents), 0);

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

  const periodOf = new Map(rows.settlement_periods.map((p) => [p.id, p.period_start]));
  const payConfigVersions = sortVersions(rows.pay_configs).map((v) => ({
    effectiveFrom: v.effective_from,
    note: v.note,
    source: v.source,
    insurancePerDayCents: v.insurance_per_day_cents,
    settledPeriods: [
      ...new Set(
        rows.settlements
          .filter((s) => s.pay_config_id === v.id)
          .map((s) => periodOf.get(s.period_id)!),
      ),
    ].sort(),
  }));

  const codeOf = new Map(rows.drivers.map((d) => [d.id, d.code]));
  const anomalies = fuelAnomalyIds(rows);
  const fuelAnomalies = (["offRoute", "overTank", "parked", "duplicate"] as const).flatMap((rule) =>
    anomalies[rule].map((id) => {
      const f = rows.fuel_purchases.find((x) => x.id === id)!;
      return {
        rule,
        purchaseRef: f.purchase_ref,
        driverCode: codeOf.get(f.driver_id)!,
        state: f.state,
        gallonsMilli: f.gallons_milli,
        amountCents: f.amount_cents,
      };
    }),
  );

  const window = lastFullMonthBefore(anchor);
  const unbilled = findUnbilledDetention(
    rows.loads.map(loadStopsOf),
    rows.customers.map(customerOf),
    rows.load_accessorials.map((a) => ({ loadId: a.load_id, kind: a.kind })),
    window,
  );
  const detention = {
    window,
    loads: unbilled.flatMap((u) =>
      u.stops.map((s) => ({
        loadNumber: u.loadNumber,
        stop: s.stop,
        overMinutes: s.overMinutes,
        cents: s.cents,
      })),
    ),
    totalCents: sum(unbilled.map((u) => u.amountCents)),
  };

  const customerCode = new Map(rows.customers.map((c) => [c.id, c.code]));
  const collections = plan.planted.collections.map((k) => {
    const i = rows.invoices.find((x) => x.id === k.invoiceId)!;
    return {
      customerCode: customerCode.get(k.customerId)!,
      class: k.customerClass,
      invoiceNumber: i.invoice_number,
      daysLate: daysBetween(i.due_on, anchor),
      balanceCents: invoiceStatus(i.amount_cents, applied.get(i.id) ?? 0).balanceCents,
    };
  });

  const r = plan.planted.invoiceReview;
  const reviewPlant = (plant: string, id: string) => {
    const i = rows.invoices.find((x) => x.id === id)!;
    return {
      plant,
      invoiceNumber: i.invoice_number,
      customerCode: customerCode.get(i.customer_id)!,
      amountCents: i.amount_cents,
    };
  };
  const invoiceReview = {
    podCustomers: r.podCustomerIds.map((id) => customerCode.get(id)!),
    plants: [
      reviewPlant("missing_documents", r.missingDocumentsInvoiceId),
      ...r.duplicateInvoiceIds.map((id) => reviewPlant("duplicate_warning", id)),
      reviewPlant("rate_mismatch", r.rateMismatchInvoiceId),
      reviewPlant("ready_to_send", r.readyInvoiceId),
      ...r.needsReviewInvoiceIds.map((id) => reviewPlant("needs_review", id)),
    ],
  };

  const cr = plan.planted.cardRecon;
  const statementPlant = (id: string) => {
    const t = rows.card_transactions.find((x) => x.id === id)!;
    return { postedOn: t.posted_on, last4: t.card_last4, amountCents: t.amount_cents, state: t.state };
  };
  const cardRecon = {
    planted: {
      fuelAmountDiffers: statementPlant(cr.fuelAmountDiffersId),
      purchaseNotRecorded: statementPlant(cr.purchaseNotRecordedId),
      cardUnknown: statementPlant(cr.cardUnknownId),
      loadNotInLedger: statementPlant(cr.loadNotInLedgerId),
    },
    candidateDriverCode: rows.drivers.find((d) => d.id === cr.candidateDriverId)?.code ?? null,
  };

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
    payConfigVersions,
    fuelAnomalies,
    detention,
    collections,
    invoiceReview,
    cardRecon,
    cashFriday: cashFridayOf(plan),
  };
}

function cashFridayOf(plan: CarrierPlan): CarrierSummary["cashFriday"] {
  const r = cashPositionOf(plan.rows, plan.carrier, plan.anchor, flags.cashFridayLimits);
  const factoring = r.options.find((o) => o.kind === "factoring_request");
  const defer = r.options.find((o) => o.kind === "bill_defer");
  return {
    payDay: r.payDay,
    bankBalanceCents: r.figures.bankBalanceCents,
    cashOnHandCents: r.figures.cashOnHandCents,
    expectedReceiptsCents: r.figures.expectedReceiptsCents,
    payRunCents: r.figures.payRunCents,
    payRunSource: r.payRunSource,
    fuelLoadsCents: r.figures.fuelLoadsCents,
    vendorBillsDueCents: r.figures.vendorBillsDueCents,
    gapCents: r.figures.gapCents,
    factoringInvoices: factoring?.kind === "factoring_request" ? factoring.invoices.length : 0,
    factoringNetCents: factoring?.amountCents ?? 0,
    deferBillRef: defer?.kind === "bill_defer" ? defer.billRef : null,
    chaseCustomers: r.options.filter((o) => o.kind === "collections_chase").length,
  };
}
