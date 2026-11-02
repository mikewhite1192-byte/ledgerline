import { describe, expect, it } from "vitest";
import { DEMO_ANCHOR } from "../seed/anchor";
import { DEMO_CARRIERS } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { configFor } from "./config-version";
import { cashFridayInputOf, checkInputOf, factoredInvoiceIds, payConfigOf, type CashFridayRows } from "./records";
import type { FactoringRequestInvoiceRow, InvoiceRow } from "./rows";

// The factoring marks Cash Friday and the factoring engine read: an invoice on a live factoring
// line is factored (the partner may hold it), and one whose only lines were declined or failed is
// the carrier's again.

const INV = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function invoice(n: number): InvoiceRow {
  return {
    id: INV(n),
    source: "load",
    load_id: INV(100 + n),
    customer_id: INV(200),
    invoice_number: `INV-${n}`,
    amount_cents: 100_000 + n,
    issued_on: "2026-10-20",
    due_on: "2026-11-19",
    status: "open",
    paid_on: null,
    qbo_id: null,
    reviewed_at: null,
    reviewed_by_membership_id: null,
    review_note: null,
    sent_on: null,
    sent_by_membership_id: null,
    qbo_email_status: null,
    qbo_amount_cents: null,
  };
}

function line(n: number, invoiceN: number, status: FactoringRequestInvoiceRow["status"]): FactoringRequestInvoiceRow {
  return {
    id: INV(300 + n),
    request_id: INV(400),
    invoice_id: INV(invoiceN),
    attempt: 1,
    balance_cents: 100_000,
    advance_cents: 90_000,
    fee_cents: 3_000,
    net_cents: 87_000,
    reserve_cents: 10_000,
    money_action_id: null,
    provider_ref: null,
    status,
    packet: {},
    settled_at: null,
  };
}

const LIMITS = { graceDays: 7, factoringMaxAgeDays: 60, maxFactorInvoices: 3, maxChaseCustomers: 3 };

function rows(invoices: InvoiceRow[], lines: FactoringRequestInvoiceRow[]): CashFridayRows {
  return {
    pay_configs: [],
    settlement_periods: [],
    settlements: [],
    drivers: [],
    loads: [],
    load_state_miles: [],
    load_accessorials: [],
    driver_days: [],
    pay_items: [],
    deduction_schedules: [],
    advances: [],
    invoices,
    customer_payments: [],
    payment_applications: [],
    vendor_bills: [],
    cash_settings: [],
    factoring_request_invoices: lines,
  };
}

describe("factoredInvoiceIds", () => {
  it("keeps every invoice on a submitted, unknown or funded line and drops declined and failed ones", () => {
    const ids = factoredInvoiceIds([
      line(1, 1, "submitted"),
      line(2, 2, "unknown"),
      line(3, 3, "funded"),
      line(4, 4, "declined"),
      line(5, 5, "failed"),
    ]);
    expect([...ids].sort()).toEqual([INV(1), INV(2), INV(3)]);
  });

  it("keeps an invoice declined once and then funded on a second attempt", () => {
    const ids = factoredInvoiceIds([line(1, 7, "declined"), line(2, 7, "funded")]);
    expect([...ids]).toEqual([INV(7)]);
  });

  it("is empty with no lines", () => {
    expect(factoredInvoiceIds([]).size).toBe(0);
  });
});

describe("cashFridayInputOf factoring marks", () => {
  it("marks only the invoices a live line holds, and leaves every other field as read", () => {
    const input = cashFridayInputOf(
      rows([invoice(1), invoice(2), invoice(3)], [line(1, 1, "funded"), line(2, 2, "declined")]),
      "America/Chicago",
      LIMITS,
    );
    expect(input.invoices.map((i) => [i.invoiceNumber, i.factored === true])).toEqual([
      ["INV-1", true],
      ["INV-2", false],
      ["INV-3", false],
    ]);
    // The mark is the only change: the cents and dates are the row's own.
    expect(input.invoices[0]).toMatchObject({ amountCents: 100_001, issuedOn: "2026-10-20", status: "open" });
    expect("factored" in input.invoices[1]).toBe(false);
  });

  it("marks nothing when no invoice was ever sent to factoring", () => {
    const input = cashFridayInputOf(rows([invoice(1)], []), "America/Chicago", LIMITS);
    expect(input.invoices.every((i) => i.factored !== true)).toBe(true);
  });
});

// The pay checks a sweep reads run under its own week's pay rules version (D-093). With one open
// week that is the version the checks read with no week named, so a sweep with the roll off reads
// exactly what it did. With two open weeks under two versions, the older week's start takes the
// older version and no week named still takes the newest open week's.
describe("checkInputOf's pay rules version", () => {
  const plan = buildCarrierPlan(DEMO_CARRIERS[0], DEMO_ANCHOR);
  const seeded = plan.rows.settlement_periods.filter((p) => p.status === "open");
  const own = configFor(plan.rows.pay_configs, seeded[0].period_start);

  it("is the same input for the one open week as with no week named", () => {
    expect(seeded.length).toBe(1);
    expect(checkInputOf(plan.rows, seeded[0].period_start)).toEqual(checkInputOf(plan.rows));
  });

  it("takes the named week's version, and the newest open week's with none named", () => {
    const nextStart = "2026-11-02";
    expect(seeded[0].period_end < nextStart).toBe(true);
    const later = {
      ...own,
      id: "00000000-0000-4000-8000-000000000901",
      effective_from: nextStart,
      insurance_per_day_cents: own.insurance_per_day_cents + 100,
    };
    const rows = {
      ...plan.rows,
      pay_configs: [...plan.rows.pay_configs, later],
      settlement_periods: [
        ...plan.rows.settlement_periods,
        { id: "00000000-0000-4000-8000-000000000902", period_start: nextStart, period_end: "2026-11-08", status: "open" as const },
      ],
    };
    expect(checkInputOf(rows, seeded[0].period_start).config).toEqual(payConfigOf(own));
    expect(checkInputOf(rows, nextStart).config).toEqual(payConfigOf(later));
    expect(checkInputOf(rows).config).toEqual(payConfigOf(later));
    expect(payConfigOf(later)).not.toEqual(payConfigOf(own));
  });
});
