import type { CarrierPlan } from "../../../seed/plan";

// One well-formed argument object per registered tool, built from a seed plan's own rows, so a
// test can call every tool for real and then break exactly one thing.

export function sampleArgs(plan: CarrierPlan): Record<string, Record<string, unknown>> {
  const rows = plan.rows;
  const hero = rows.drivers.find((d) => d.code === plan.carrier.heroCode) ?? rows.drivers[0];
  const open = rows.settlement_periods.find((p) => p.status === "open")!;
  const paid = rows.settlement_periods.find((p) => p.status === "paid")!;
  const invoice = rows.invoices.find((i) => i.source === "load" && i.status === "open")!;
  const input = rows.untrusted_inputs[0];
  const wrong = plan.planted.wrongInvoice;
  const doc = rows.untrusted_inputs.find((i) => i.kind === "document") ?? input;
  const noRate = rows.loads.find((l) => l.id === plan.planted.noRateLoadId)!;
  // The first planted unbilled detention: 41,250 cents in October.
  const detentionLoad = plan.planted.detentionLoadIds[0];
  const delivered = rows.loads.find((l) => l.status === "delivered") ?? rows.loads[0];
  const refs = [{ table: "drivers", id: hero.id }];
  return {
    get_driver: { driverId: hero.id },
    get_loads: { driverId: hero.id, from: paid.period_start, to: open.period_end },
    get_pay_items: { driverId: hero.id, periodStart: paid.period_start, periodEnd: open.period_end },
    get_advances: { driverId: hero.id },
    get_invoices: { status: "open" },
    get_customer_payments: {},
    get_ledger: { driverId: hero.id },
    explain_paystub: { driverId: hero.id, periodId: paid.id },
    get_settlements: { periodId: paid.id },
    run_checks: {},
    get_inbound_message: { inputId: input.id },
    get_document: { inputId: doc.id },
    get_voice_note: { inputId: input.id },
    propose_advance: {
      driverId: hero.id,
      amountCents: 10_000,
      requestedOn: "2026-10-31",
      operatorVerdict: "eligible",
      reasonCategories: ["driver_asked"],
      sourceRefs: refs,
    },
    propose_pay_correction: {
      driverId: hero.id,
      periodId: open.id,
      deltaCents: 2_500,
      operatorVerdict: "owed_to_driver",
      reasonCategories: ["missed_pay"],
      sourceRefs: refs,
    },
    propose_invoice_fix: {
      invoiceId: invoice.id,
      newAmountCents: invoice.amount_cents + 100,
      reasonCategories: ["rate_mismatch"],
      sourceRefs: [{ table: "invoices", id: invoice.id }],
    },
    get_invoice_queue: {},
    get_invoice_review: { invoiceId: invoice.id },
    get_invoice_review_queue: { status: "needs_review" },
    get_ar_aging: { asOf: open.period_end, minBucket: "1_30" },
    get_payments_in: { from: paid.period_start, to: open.period_end },
    propose_payment_reapply: {
      paymentId: wrong.paymentId,
      applicationId: wrong.applicationId,
      fromInvoiceId: wrong.appliedToInvoiceId,
      toInvoiceId: wrong.meantForInvoiceId,
      sourceRefs: [{ table: "customer_payments", id: wrong.paymentId }],
    },
    propose_load_rate: {
      loadId: noRate.id,
      linehaulCents: 245 * noRate.loaded_miles,
      fuelSurchargeCents: noRate.fuel_surcharge_cents,
      ratePerMileCents: 245,
      requestRef: doc.id,
      sourceRefs: [{ table: "loads", id: noRate.id }],
    },
    find_unbilled_detention: { month: "2026-10" },
    propose_detention_charge: {
      loadId: detentionLoad,
      amountCents: 41_250,
      sourceRefs: [{ table: "loads", id: detentionLoad }],
    },
    get_portal_evidence: { loadId: delivered.id },
    classify_message: { inputId: input.id, category: "pay_question", urgency: "normal" },
    report_ar_aging: { asOf: "2026-11-02" },
    report_driver_pay_summary: { periodStart: paid.period_start, driverId: hero.id },
    report_advances_outstanding: {},
    report_cash_needed: { periodStart: open.period_start },
    report_margin_per_load: {
      periodStart: paid.period_start,
      periodEnd: open.period_end,
      customerId: invoice.customer_id,
    },
    get_driver_identity: { driverId: hero.id },
    get_advance_headroom: { driverId: hero.id, amountCents: 10_000 },
    // Proposals are not in a seed plan; any well-formed id parses.
    get_proposal: { proposalId: "6a1f0c2e-9d3b-4c5a-8e7f-1b2c3d4e5f60" },
  };
}
