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
    run_checks: {},
    get_inbound_message: { inputId: input.id },
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
    classify_message: { inputId: input.id, category: "pay_question", urgency: "normal" },
  };
}
