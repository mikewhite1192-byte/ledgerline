import { describe, expect, it } from "vitest";
import { addDays } from "../time/local-date";
import {
  billDeferOption,
  billsDue,
  computeCashFriday,
  expectedReceipts,
  payDayFor,
  typicalDaysLate,
} from "./cash-friday";
import { sum } from "./money";
import { settleDriver } from "./settlement";
import { advance, BLUE_RIDGE, c, driver, load } from "./test-records";
import {
  InputError,
  type AdvanceRecord,
  type CashFridayInput,
  type CashPosition,
  type CustomerPaymentRecord,
  type InvoiceRecord,
  type PaidOn,
  type PaymentApplicationRecord,
  type PaymentProfile,
  type SettlementInput,
  type SettlementRecord,
  type VendorBillRecord,
} from "./types";

// The golden week: the open period is Monday Oct 26 to Sunday Nov 1, so pay day (Friday) is Nov 6,
// and the check runs on Monday Nov 2. The bank balance is as of Nov 1; b7, a bill paid on Nov 2,
// takes 70,000 of it back out.
const AS_OF = "2026-11-02";
const PERIOD = { id: "per-open", periodStart: "2026-10-26", periodEnd: "2026-11-01", status: "open" as const };
const CLOSED = { id: "per-closed", periodStart: "2026-10-19", periodEnd: "2026-10-25", status: "paid" as const };
const LIMITS = { graceDays: 14, factoringMaxAgeDays: 45, maxFactorInvoices: 3, maxChaseCustomers: 2 };
const SETTINGS = {
  id: "cash-1",
  bankBalanceCents: c(270_000),
  balanceAsOf: "2026-11-01",
  payDayDow: 5,
  factoringAdvanceBps: 9000,
  factoringFeeBps: 300,
};

function invoice(over: Partial<InvoiceRecord> & { id: string; customerId: string }): InvoiceRecord {
  return {
    source: "load",
    loadId: `load-${over.id}`,
    invoiceNumber: `INV-${over.id}`,
    amountCents: c(10_000),
    issuedOn: "2026-10-01",
    dueOn: "2026-10-31",
    status: "open",
    paidOn: null,
    qboId: null,
    ...over,
  };
}

function payment(id: string, customerId: string, receivedOn: string, amount: number): CustomerPaymentRecord {
  return {
    id,
    customerId,
    receivedOn,
    amountCents: c(amount),
    method: "ach",
    paymentRef: `REF-${id}`,
    source: "seed",
    memo: null,
    qboId: null,
  };
}

function applied(id: string, paymentId: string, invoiceId: string, amount: number): PaymentApplicationRecord {
  return { id, paymentId, invoiceId, amountCents: c(amount) };
}

// A paid invoice of the customer's history: issued 30 days before due, paid `late` days after due.
function history(customerId: string, n: number, dueOn: string, late: number) {
  const id = `${customerId}-h${n}`;
  const paidOn = addDays(dueOn, late);
  return {
    invoice: invoice({ id, customerId, amountCents: c(10_000), issuedOn: addDays(dueOn, -30), dueOn, status: "paid" }),
    payment: payment(`${id}-p`, customerId, paidOn, 10_000),
    application: applied(`${id}-a`, `${id}-p`, id, 10_000),
  };
}

function settlement(over: Partial<SettlementRecord & PaidOn> & { id: string }): SettlementRecord & PaidOn {
  return {
    periodId: PERIOD.id,
    driverId: "drv-1",
    status: "draft",
    grossCents: c(0),
    deductionsCents: c(0),
    netCents: c(0),
    carryForwardCents: c(0),
    exceptionCount: 0,
    paidAt: null,
    paidOn: null,
    ...over,
  };
}

function cashAdvance(over: Partial<AdvanceRecord & PaidOn> & { id: string }): AdvanceRecord & PaidOn {
  return { ...advance(over), paidOn: over.paidOn ?? null };
}

function bill(over: Partial<VendorBillRecord> & { id: string }): VendorBillRecord {
  return {
    billRef: `BILL-${over.id.toUpperCase()}`,
    vendorName: "Sample Vendor",
    category: "maintenance",
    amountCents: c(10_000),
    dueOn: "2026-11-04",
    urgency: "fixed",
    status: "open",
    deferredTo: null,
    paidOn: null,
    ...over,
  };
}

// Customers: R reliable (always on the due date), M mixed (one of four late, median -1.5 days),
// N new (nothing paid yet), L repeat late (both paid 20 days late).
const HISTORY = [
  ...[1, 2, 3, 4, 5].map((n) => history("cust-r", n, `2026-09-0${n}`, 0)),
  ...[-3, -2, -1, 4].map((late, i) => history("cust-m", i + 1, `2026-09-1${i}`, late)),
  ...[1, 2].map((n) => history("cust-l", n, `2026-08-0${n}`, 20)),
];

const OPEN_INVOICES: InvoiceRecord[] = [
  invoice({ id: "R1", customerId: "cust-r", amountCents: c(100_000), issuedOn: "2026-10-06", dueOn: "2026-11-05" }),
  invoice({ id: "R2", customerId: "cust-r", amountCents: c(50_000), issuedOn: "2026-10-21", dueOn: "2026-11-20" }),
  invoice({ id: "R3", customerId: "cust-r", amountCents: c(70_000), issuedOn: "2026-09-01", dueOn: "2026-11-25" }),
  invoice({
    id: "R4",
    customerId: "cust-r",
    source: "opening",
    loadId: null,
    amountCents: c(20_000),
    issuedOn: "2026-10-30",
    dueOn: "2026-12-01",
  }),
  invoice({ id: "M1", customerId: "cust-m", amountCents: c(100_000), issuedOn: "2026-10-08", dueOn: "2026-11-07" }),
  invoice({ id: "M2", customerId: "cust-m", amountCents: c(60_005), issuedOn: "2026-10-31", dueOn: "2026-11-30" }),
  invoice({ id: "N1", customerId: "cust-n", amountCents: c(30_000), issuedOn: "2026-09-30", dueOn: "2026-10-30" }),
  invoice({ id: "L1", customerId: "cust-l", amountCents: c(40_000), issuedOn: "2026-08-02", dueOn: "2026-09-01" }),
  invoice({ id: "L2", customerId: "cust-l", amountCents: c(25_000), issuedOn: "2026-10-11", dueOn: "2026-11-10" }),
  invoice({ id: "V1", customerId: "cust-r", amountCents: c(90_000), status: "void", dueOn: "2026-11-03" }),
];

const BILLS: VendorBillRecord[] = [
  bill({ id: "b1", amountCents: c(40_000), dueOn: "2026-11-04", urgency: "fixed" }),
  bill({ id: "b2", amountCents: c(25_000), dueOn: "2026-11-05", urgency: "flexible" }),
  bill({ id: "b3", amountCents: c(30_000), dueOn: "2026-11-06", urgency: "flexible" }),
  bill({ id: "b4", amountCents: c(90_000), dueOn: "2026-11-07", urgency: "flexible" }),
  bill({ id: "b5", amountCents: c(10_000), dueOn: "2026-10-30", status: "deferred", deferredTo: "2026-11-06" }),
  bill({ id: "b6", amountCents: c(60_000), dueOn: "2026-11-03", status: "deferred", deferredTo: "2026-11-13" }),
  // Paid on Nov 2: inside the window, so it has left the bank, and it is no longer due.
  bill({ id: "b7", amountCents: c(70_000), dueOn: "2026-11-02", status: "paid", paidOn: "2026-11-02" }),
];

// The engine's own input for one driver in the open week: one load delivered on Oct 28.
const WEEK = { start: PERIOD.periodStart, end: PERIOD.periodEnd };

function preview(id: string, linehaul: number): SettlementInput {
  return {
    config: BLUE_RIDGE,
    driver: driver({ id }),
    period: WEEK,
    loads: [
      load({ id: `${id}-l1`, driverId: id, pickupOn: "2026-10-27", deliveredOn: "2026-10-28", linehaulCents: c(linehaul) }),
    ],
    days: [],
    items: [],
    schedules: [],
    advances: [],
    escrowBalanceCents: c(0),
  };
}

// Every driver active in the golden week, each with a row for it: drv-1 a draft, drv-2 approved,
// drv-3 already paid. Their own nets differ from the stored ones, so a total shows which it read.
const GOLDEN_PREVIEWS = [preview("drv-1", 140_000), preview("drv-2", 125_000), preview("drv-3", 90_000)];

function golden(over: Partial<CashFridayInput> = {}): CashFridayInput {
  return {
    settings: SETTINGS,
    periods: [CLOSED, PERIOD],
    settlements: [
      // Paid for last week on Nov 2: inside the window, so it has left the bank.
      settlement({ id: "s-paid", periodId: CLOSED.id, status: "paid", netCents: c(5_000), paidOn: "2026-11-02" }),
      settlement({ id: "s-draft", status: "draft", netCents: c(150_000) }),
      settlement({ id: "s-approved", driverId: "drv-2", status: "approved", netCents: c(120_000) }),
      // A row already paid (before the balance date) is not part of the run.
      settlement({ id: "s-early", driverId: "drv-3", status: "paid", netCents: c(999_000), paidOn: "2026-10-30" }),
    ],
    previews: GOLDEN_PREVIEWS,
    advances: [
      cashAdvance({ id: "a1", status: "paid", amountCents: c(30_000), paidOn: "2026-11-02" }),
      cashAdvance({ id: "a2", status: "paid", amountCents: c(40_000), paidOn: "2026-10-30" }),
      cashAdvance({ id: "a3", status: "requested", amountCents: c(20_000), paidAt: null }),
      cashAdvance({ id: "a4", status: "approved", amountCents: c(15_000), paidAt: null }),
      cashAdvance({ id: "a5", status: "rejected", amountCents: c(50_000), paidAt: null }),
    ],
    invoices: [...HISTORY.map((h) => h.invoice), ...OPEN_INVOICES],
    payments: [
      ...HISTORY.map((h) => h.payment),
      // Received on Nov 2: inside the window. Part of it pays M1.
      payment("pay-m1", "cust-m", "2026-11-02", 19_999),
      // Received on the balance date: already in the balance.
      payment("pay-old", "cust-r", "2026-11-01", 70_000),
    ],
    applications: [...HISTORY.map((h) => h.application), applied("app-m1", "pay-m1", "M1", 19_999)],
    bills: BILLS,
    limits: LIMITS,
    ...over,
  };
}

function position(input: CashFridayInput, asOf = AS_OF): CashPosition {
  const result = computeCashFriday(input, asOf);
  if (!result.ok) throw new Error(`refused: ${result.refusal}`);
  return result;
}

describe("computeCashFriday on the golden week", () => {
  const result = position(golden());

  it("finds pay day and the open week", () => {
    expect(result.payDay).toBe("2026-11-06");
    expect(result.periodId).toBe(PERIOD.id);
    expect(result.period).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(result.payRunSource).toBe("stored");
  });

  it("computes every figure to the cent", () => {
    expect(result.figures).toEqual({
      bankBalanceCents: 270_000,
      balanceAsOf: "2026-11-01",
      paymentsSinceCents: 19_999,
      advancesPaidSinceCents: 30_000,
      settlementsPaidSinceCents: 5_000,
      billsPaidSinceCents: 70_000,
      cashOnHandCents: 184_999,
      expectedReceiptsCents: 175_001,
      payRunCents: 270_000,
      fuelLoadsCents: 35_000,
      vendorBillsDueCents: 105_000,
      gapCents: -50_000,
    });
    const f = result.figures;
    expect(
      f.bankBalanceCents + f.paymentsSinceCents - f.advancesPaidSinceCents - f.settlementsPaidSinceCents - f.billsPaidSinceCents,
    ).toBe(f.cashOnHandCents);
    expect(f.cashOnHandCents + f.expectedReceiptsCents - f.payRunCents - f.fuelLoadsCents - f.vendorBillsDueCents).toBe(
      f.gapCents,
    );
  });

  it("lists every open invoice: counted, then after pay day, then stalled", () => {
    expect(result.lines.map((l) => [l.invoiceId, l.status, l.expectedOn, l.expectedCents])).toEqual([
      ["R1", "counted", "2026-11-05", 100_000],
      ["M1", "counted", "2026-11-06", 60_001],
      ["N1", "counted", "2026-11-06", 15_000],
      ["R2", "after_pay_day", "2026-11-20", 0],
      ["R3", "after_pay_day", "2026-11-25", 0],
      ["M2", "after_pay_day", "2026-11-29", 0],
      ["L2", "after_pay_day", "2026-11-30", 0],
      ["R4", "after_pay_day", "2026-12-01", 0],
      ["L1", "stalled", "2026-11-02", 0],
    ]);
  });

  it("counts a partly paid invoice at its balance, at the customer's on-time share, rounded half up", () => {
    const m1 = result.lines.find((l) => l.invoiceId === "M1");
    expect(m1).toMatchObject({ balanceCents: 80_001, typicalDaysLate: -1, onTimeBps: 7500, label: "mixed" });
    // 80,001 x 0.75 = 60,000.75, which rounds to 60,001.
    expect(m1?.expectedCents).toBe(60_001);
  });

  it("counts a customer with nothing paid at half, expected a week late", () => {
    expect(result.lines.find((l) => l.invoiceId === "N1")).toMatchObject({
      typicalDaysLate: 7,
      onTimeBps: 5000,
      label: "mixed",
      expectedCents: 15_000,
    });
  });

  it("drafts the three kinds of option in order", () => {
    expect(result.options.map((o) => [o.kind, o.subjectTable, o.subjectId])).toEqual([
      ["factoring_request", "settlement_periods", PERIOD.id],
      ["bill_defer", "vendor_bills", "b3"],
      ["collections_chase", "customers", "cust-l"],
      ["collections_chase", "customers", "cust-n"],
    ]);
  });

  it("factors the largest recent invoice not expected by pay day", () => {
    const factoring = result.options[0];
    expect(factoring).toMatchObject({
      kind: "factoring_request",
      direction: "in",
      advanceBps: 9000,
      feeBps: 300,
      amountCents: 52_205,
      balanceCents: 60_005,
      advanceCents: 54_005,
      feeCents: 1_800,
      reserveCents: 6_000,
      coversShort: true,
    });
    if (factoring.kind !== "factoring_request") throw new Error("not factoring");
    expect(factoring.invoices).toEqual([
      {
        invoiceId: "M2",
        invoiceNumber: "INV-M2",
        customerId: "cust-m",
        balanceCents: 60_005,
        advanceCents: 54_005,
        feeCents: 1_800,
        netCents: 52_205,
        reserveCents: 6_000,
      },
    ]);
    expect(factoring.advanceCents - factoring.feeCents).toBe(factoring.amountCents);
    expect(factoring.advanceCents + factoring.reserveCents).toBe(factoring.balanceCents);
  });

  it("delays the largest flexible bill due by pay day to a week after pay day", () => {
    expect(result.options[1]).toEqual({
      kind: "bill_defer",
      subjectTable: "vendor_bills",
      subjectId: "b3",
      direction: "none",
      amountCents: 30_000,
      billRef: "BILL-B3",
      dueOn: "2026-11-06",
      deferredTo: "2026-11-13",
      coversShort: false,
      sources: [{ table: "vendor_bills", id: "b3" }],
    });
  });

  it("chases the customers with the largest past-due balances", () => {
    // L1 is stalled, so none of it is expected: all 40,000 is new cash. N1 is counted at half
    // (15,000) by pay day, so chasing it adds only the other 15,000. Neither closes the 50,000 short.
    expect(result.options.slice(2)).toEqual([
      {
        kind: "collections_chase",
        subjectTable: "customers",
        subjectId: "cust-l",
        direction: "in",
        amountCents: 40_000,
        newCashCents: 40_000,
        coversShort: false,
        label: "repeat_late",
        overdueInvoices: 1,
        invoices: [{ invoiceId: "L1", invoiceNumber: "INV-L1", balanceCents: 40_000, dueOn: "2026-09-01", daysLate: 62 }],
        sources: [
          { table: "customers", id: "cust-l" },
          { table: "invoices", id: "L1" },
        ],
      },
      {
        kind: "collections_chase",
        subjectTable: "customers",
        subjectId: "cust-n",
        direction: "in",
        amountCents: 30_000,
        newCashCents: 15_000,
        coversShort: false,
        label: "mixed",
        overdueInvoices: 1,
        invoices: [{ invoiceId: "N1", invoiceNumber: "INV-N1", balanceCents: 30_000, dueOn: "2026-10-30", daysLate: 3 }],
        sources: [
          { table: "customers", id: "cust-n" },
          { table: "invoices", id: "N1" },
        ],
      },
    ]);
  });

  it("cites the week, the pay run, the fuel loads and the bills due", () => {
    expect(result.sources).toEqual([
      { table: "settlement_periods", id: PERIOD.id },
      { table: "settlements", id: "s-draft" },
      { table: "settlements", id: "s-approved" },
      { table: "advances", id: "a3" },
      { table: "advances", id: "a4" },
      { table: "vendor_bills", id: "b1" },
      { table: "vendor_bills", id: "b2" },
      { table: "vendor_bills", id: "b3" },
      { table: "vendor_bills", id: "b5" },
    ]);
  });

  it("gives the same answer for the same records", () => {
    expect(position(golden())).toEqual(result);
  });
});

describe("computeCashFriday when the bank covers the run", () => {
  it("drafts no option", () => {
    const result = position(golden({ settings: { ...SETTINGS, bankBalanceCents: c(370_000) } }));
    expect(result.figures.gapCents).toBe(50_000);
    expect(result.options).toEqual([]);
  });

  it("drafts no option when the gap is exactly zero", () => {
    const result = position(golden({ settings: { ...SETTINGS, bankBalanceCents: c(320_000) } }));
    expect(result.figures.gapCents).toBe(0);
    expect(result.options).toEqual([]);
  });
});

describe("computeCashFriday option limits", () => {
  it("takes more invoices when one does not cover a larger short, and says it still falls short", () => {
    const result = position(golden({ settings: { ...SETTINGS, bankBalanceCents: c(170_000) } }));
    expect(result.figures.gapCents).toBe(-150_000);
    const factoring = result.options[0];
    if (factoring.kind !== "factoring_request") throw new Error("not factoring");
    // M2 nets 52,205; R2 (50,000) advances 45,000 less a 1,500 fee: 43,500; L2 (25,000, a repeat
    // late payer's, expected after pay day) advances 22,500 less a 750 fee: 21,750. R3 is too old.
    expect(factoring.invoices.map((i) => [i.invoiceId, i.netCents])).toEqual([
      ["M2", 52_205],
      ["R2", 43_500],
      ["L2", 21_750],
    ]);
    expect(factoring.amountCents).toBe(117_455);
    expect(factoring.coversShort).toBe(false);
  });

  it("factors a repeat late payer's invoice like any other: the fee and the reserve price the wait", () => {
    const result = position(golden({ settings: { ...SETTINGS, bankBalanceCents: c(170_000) } }));
    expect(result.lines.find((l) => l.invoiceId === "L2")).toMatchObject({ label: "repeat_late", status: "after_pay_day" });
    const factoring = result.options[0];
    if (factoring.kind !== "factoring_request") throw new Error("not factoring");
    expect(factoring.invoices.find((i) => i.invoiceId === "L2")).toMatchObject({ customerId: "cust-l", netCents: 21_750 });
  });

  it("never factors an invoice the engine already counts by pay day", () => {
    const result = position(golden({ settings: { ...SETTINGS, bankBalanceCents: c(170_000) } }));
    const factoring = result.options[0];
    if (factoring.kind !== "factoring_request") throw new Error("not factoring");
    const counted = new Set(result.lines.filter((l) => l.status === "counted").map((l) => l.invoiceId));
    expect(factoring.invoices.some((i) => counted.has(i.invoiceId))).toBe(false);
  });

  it("stops at the invoice limit", () => {
    const result = position(
      golden({
        settings: { ...SETTINGS, bankBalanceCents: c(170_000) },
        limits: { ...LIMITS, maxFactorInvoices: 1 },
      }),
    );
    const factoring = result.options[0];
    if (factoring.kind !== "factoring_request") throw new Error("not factoring");
    expect(factoring.invoices.map((i) => i.invoiceId)).toEqual(["M2"]);
  });

  it("chases only as many customers as the limit allows", () => {
    const result = position(golden({ limits: { ...LIMITS, maxChaseCustomers: 1 } }));
    expect(result.options.filter((o) => o.kind === "collections_chase").map((o) => o.subjectId)).toEqual(["cust-l"]);
  });

  it("drafts no factoring card when no invoice qualifies", () => {
    const result = position(golden({ limits: { ...LIMITS, factoringMaxAgeDays: 0 } }));
    expect(result.options.map((o) => o.kind)).toEqual(["bill_defer", "collections_chase", "collections_chase"]);
  });

  it("refuses a limit that is not a whole number", () => {
    expect(() => computeCashFriday(golden({ limits: { ...LIMITS, graceDays: 1.5 } }), AS_OF)).toThrow(InputError);
  });
});

// An invoice on a live factoring line belongs to the factoring partner to collect.
describe("an invoice already factored", () => {
  const withFactored = (ids: readonly string[]) =>
    golden({
      invoices: [
        ...HISTORY.map((h) => h.invoice),
        ...OPEN_INVOICES.map((i) => (ids.includes(i.id) ? { ...i, factored: true } : i)),
      ],
    });

  it("is never counted by pay day, chased or offered for factoring again", () => {
    const result = position(withFactored(["M2", "N1"]));
    const listed = result.lines.map((l) => l.invoiceId);
    expect(listed).not.toContain("M2");
    expect(listed).not.toContain("N1");
    // N1's 15,000 is no longer expected from the customer, so the short grows by that much.
    expect(result.figures.expectedReceiptsCents).toBe(160_001);
    expect(result.figures.gapCents).toBe(-65_000);
    const factoring = result.options[0];
    if (factoring.kind !== "factoring_request") throw new Error("not factoring");
    // M2 is gone, so the next two recent invoices not expected by pay day cover the short.
    expect(factoring.invoices.map((i) => [i.invoiceId, i.netCents])).toEqual([
      ["R2", 43_500],
      ["L2", 21_750],
    ]);
    expect(factoring.coversShort).toBe(true);
    expect(result.options.filter((o) => o.kind === "collections_chase").map((o) => o.subjectId)).toEqual(["cust-l"]);
  });

  it("changes nothing for the invoices that are not factored", () => {
    const before = position(golden());
    const after = position(withFactored(["R3"]));
    expect(after.figures).toEqual(before.figures);
    expect(after.options).toEqual(before.options);
    expect(after.lines.map((l) => l.invoiceId)).toEqual(before.lines.map((l) => l.invoiceId).filter((id) => id !== "R3"));
  });
});

describe("computeCashFriday refusals", () => {
  it("refuses without a bank balance", () => {
    expect(computeCashFriday(golden({ settings: null }), AS_OF)).toEqual({ ok: false, refusal: "balance_missing" });
  });

  it("refuses a balance dated after today", () => {
    const settings = { ...SETTINGS, balanceAsOf: "2026-11-03" };
    expect(computeCashFriday(golden({ settings }), AS_OF)).toEqual({ ok: false, refusal: "balance_in_future" });
  });

  it("refuses with no open week, and with two", () => {
    expect(computeCashFriday(golden({ periods: [CLOSED] }), AS_OF)).toEqual({ ok: false, refusal: "no_open_period" });
    const second = { ...CLOSED, id: "per-2", status: "open" as const };
    expect(computeCashFriday(golden({ periods: [second, PERIOD] }), AS_OF)).toEqual({
      ok: false,
      refusal: "more_than_one_open_period",
    });
  });

  it("refuses when the week has no stored run and no preview could be built", () => {
    const settlements = golden().settlements.filter((s) => s.periodId !== PERIOD.id);
    expect(computeCashFriday(golden({ settlements, previews: null }), AS_OF)).toEqual({
      ok: false,
      refusal: "pay_run_unknown",
    });
  });
});

describe("computeCashFriday pay run preview", () => {
  const settlements = golden().settlements.filter((s) => s.periodId !== PERIOD.id);
  const previews = [preview("drv-a", 110_000), preview("drv-b", 95_000)];

  it("sums the engine's own settlement of every driver in the week", () => {
    const nets = previews.map((p) => settleDriver(p).netCents);
    expect(nets.every((n) => n > 0)).toBe(true);
    const result = position(golden({ settlements, previews }));
    expect(result.payRunSource).toBe("preview");
    expect(result.figures.payRunCents).toBe(nets[0] + nets[1]);
    expect(result.sources).toEqual(
      expect.arrayContaining([
        { table: "drivers", id: "drv-a" },
        { table: "drivers", id: "drv-b" },
      ]),
    );
  });

  it("gives the same run as stored rows carrying the same nets", () => {
    const nets = previews.map((p) => settleDriver(p).netCents);
    const stored = [
      settlement({ id: "s-a", driverId: "drv-a", netCents: nets[0] }),
      settlement({ id: "s-b", driverId: "drv-b", netCents: nets[1] }),
    ];
    const fromPreview = position(golden({ settlements, previews }));
    const fromStored = position(golden({ settlements: [...settlements, ...stored], previews }));
    expect(fromStored.payRunSource).toBe("stored");
    expect(fromStored.figures).toEqual(fromPreview.figures);
  });

  it("prefers the stored run once the week has one", () => {
    const own = sum(GOLDEN_PREVIEWS.slice(0, 2).map((p) => settleDriver(p).netCents));
    expect(own).not.toBe(270_000);
    const result = position(golden());
    expect(result.payRunSource).toBe("stored");
    expect(result.figures.payRunCents).toBe(270_000);
  });

  it("refuses a preview built for another week", () => {
    const other = { ...preview("drv-a", 110_000), period: { start: "2026-10-19", end: "2026-10-25" } };
    expect(computeCashFriday(golden({ settlements, previews: [other] }), AS_OF)).toEqual({
      ok: false,
      refusal: "pay_run_unknown",
    });
  });

  it("refuses a preview the engine cannot settle, never counting it as zero", () => {
    const broken = preview("drv-a", 110_000);
    broken.loads[0] = { ...broken.loads[0], linehaulCents: 1.5 as never };
    expect(computeCashFriday(golden({ settlements, previews: [broken] }), AS_OF)).toEqual({
      ok: false,
      refusal: "pay_run_unknown",
    });
  });

  it("stops recovering an advance a person took back, as the pay math does", () => {
    // 0027: what was taken back no longer counts as owed, so the week's settlement recovers less.
    const owed = advance({ id: "adv-x", driverId: "drv-a", amountCents: c(10_000) });
    const kept = { ...preview("drv-a", 110_000), advances: [owed] };
    const takenBack = { ...kept, advances: [{ ...owed, takenBackCents: c(10_000) }] };
    const keptRun = position(golden({ settlements, previews: [kept] })).figures.payRunCents;
    const takenBackRun = position(golden({ settlements, previews: [takenBack] })).figures.payRunCents;
    expect(keptRun).toBe(settleDriver(kept).netCents);
    expect(takenBackRun).toBe(settleDriver(takenBack).netCents);
    expect(takenBackRun).toBe(keptRun + 10_000);
  });

  it("counts an empty week's run as zero only when there is no driver to pay", () => {
    const result = position(golden({ settlements, previews: [] }));
    expect(result.payRunSource).toBe("preview");
    expect(result.figures.payRunCents).toBe(0);
  });
});

describe("computeCashFriday stored run", () => {
  const unknown = { ok: false, refusal: "pay_run_unknown" };

  it("reads a run stopped partway as unknown, never the part it stored", () => {
    // drv-4 is active in the week with pay coming and has no row: the run stopped before it.
    const late = preview("drv-4", 80_000);
    expect(settleDriver(late).netCents).toBeGreaterThan(0);
    expect(computeCashFriday(golden({ previews: [...GOLDEN_PREVIEWS, late] }), AS_OF)).toEqual(unknown);
  });

  it("reads a stored run as unknown when the week's drivers could not be read", () => {
    expect(computeCashFriday(golden({ previews: null }), AS_OF)).toEqual(unknown);
  });

  it("counts a driver already paid for the week as part of the run, and reads it as missing without that row", () => {
    expect(settleDriver(GOLDEN_PREVIEWS[2]).netCents).toBeGreaterThan(0);
    expect(position(golden()).figures.payRunCents).toBe(270_000);
    const settlements = golden().settlements.filter((s) => s.id !== "s-early");
    expect(computeCashFriday(golden({ settlements }), AS_OF)).toEqual(unknown);
  });

  it("keeps the stored run when a driver it has no row for has nothing to pay, as the run skips them", () => {
    const idle = { ...preview("drv-5", 0), loads: [] };
    expect(settleDriver(idle)).toMatchObject({ netCents: 0, lines: [] });
    const result = position(golden({ previews: [...GOLDEN_PREVIEWS, idle] }));
    expect(result.payRunSource).toBe("stored");
    expect(result.figures.payRunCents).toBe(270_000);
  });

  it("reads a stored run as unknown when a driver it has no row for cannot be settled", () => {
    const broken = preview("drv-4", 80_000);
    broken.loads[0] = { ...broken.loads[0], linehaulCents: 1.5 as never };
    expect(computeCashFriday(golden({ previews: [...GOLDEN_PREVIEWS, broken] }), AS_OF)).toEqual(unknown);
  });

  it("reads a stored run as unknown when a driver's input is for another week", () => {
    const other = { ...GOLDEN_PREVIEWS[0], period: { start: "2026-10-19", end: "2026-10-25" } };
    expect(computeCashFriday(golden({ previews: [other, ...GOLDEN_PREVIEWS.slice(1)] }), AS_OF)).toEqual(unknown);
  });
});

describe("cash on hand window", () => {
  it("leaves out what moved on or before the balance date and after today", () => {
    const result = position(
      golden({
        payments: [...golden().payments, payment("pay-late", "cust-r", "2026-11-03", 1_000)],
        advances: [...golden().advances, cashAdvance({ id: "a6", status: "paid", amountCents: c(7_000), paidOn: "2026-11-01" })],
      }),
    );
    expect(result.figures.paymentsSinceCents).toBe(19_999);
    expect(result.figures.advancesPaidSinceCents).toBe(30_000);
  });

  it("keeps a taken-back advance in what went out, and drops one cancelled before payout", () => {
    // A take-back records the decision and moves no money (0027), so the card load still left
    // the bank; one taken back before payout is cancelled and no longer waits to go out.
    const base = position(golden()).figures;
    const result = position(
      golden({
        advances: [
          ...golden().advances,
          cashAdvance({ id: "a7", status: "paid", amountCents: c(9_000), takenBackCents: c(9_000), paidOn: "2026-11-02" }),
          cashAdvance({ id: "a8", status: "cancelled", amountCents: c(5_000), paidAt: null }),
        ],
      }),
    );
    expect(result.figures.advancesPaidSinceCents).toBe(base.advancesPaidSinceCents + 9_000);
    expect(result.figures.fuelLoadsCents).toBe(base.fuelLoadsCents);
  });

  it("takes a bill paid since the balance date out of cash on hand, through today, and no other", () => {
    // The window is after Nov 1 (the balance date) through Nov 4 (today). Every bill below is
    // paid, so none of them is due by pay day either way.
    const asOf = "2026-11-04";
    const base = position(golden(), asOf).figures;
    const paid = (id: string, paidOn: string, amount: number) =>
      bill({ id, amountCents: c(amount), dueOn: "2026-10-28", status: "paid", paidOn });
    const result = position(
      golden({
        bills: [
          ...BILLS,
          paid("p-before", "2026-10-30", 1_000), // before the balance date: in the balance
          paid("p-balance-day", "2026-11-01", 2_000), // on the balance date: in the balance
          paid("p-inside", "2026-11-03", 4_000), // inside the window
          paid("p-today", "2026-11-04", 8_000), // today: the last day of the window
          paid("p-tomorrow", "2026-11-05", 16_000), // after today: not out yet
        ],
      }),
      asOf,
    ).figures;
    expect(base.billsPaidSinceCents).toBe(70_000);
    expect(result.billsPaidSinceCents).toBe(70_000 + 4_000 + 8_000);
    expect(result.cashOnHandCents).toBe(base.cashOnHandCents - 12_000);
    expect(result.vendorBillsDueCents).toBe(base.vendorBillsDueCents);
    expect(result.gapCents).toBe(base.gapCents - 12_000);
  });

  it("leaves out a bill paid on the balance date or after today on the golden day", () => {
    const base = position(golden()).figures;
    const result = position(
      golden({
        bills: [
          ...BILLS,
          bill({ id: "p-balance-day", amountCents: c(3_000), status: "paid", paidOn: "2026-11-01" }),
          bill({ id: "p-tomorrow", amountCents: c(5_000), status: "paid", paidOn: "2026-11-03" }),
        ],
      }),
    ).figures;
    expect(result).toEqual(base);
  });
});

describe("an unapplied payment counts once", () => {
  // The golden week's own payments: pay-m1 (Nov 2) is applied in full to M1, and pay-old (Nov 1,
  // unapplied) is in the balance itself. Neither takes anything off the counted lines.
  const base = position(golden());
  const counted = (r: CashPosition, id: string) => r.lines.find((l) => l.invoiceId === id)?.expectedCents;

  it("takes a payment received since the balance date and not applied off its customer's expected receipts", () => {
    const result = position(golden({ payments: [...golden().payments, payment("pay-r-new", "cust-r", "2026-11-02", 30_000)] }));
    // In cash on hand once, out of R1's counted 100,000 once: the gap does not move.
    expect(result.figures.cashOnHandCents).toBe(base.figures.cashOnHandCents + 30_000);
    expect(counted(result, "R1")).toBe(70_000);
    expect(result.figures.expectedReceiptsCents).toBe(base.figures.expectedReceiptsCents - 30_000);
    expect(result.figures.gapCents).toBe(base.figures.gapCents);
    expect(result.lines.find((l) => l.invoiceId === "R1")?.sources).toContainEqual({
      table: "customer_payments",
      id: "pay-r-new",
    });
    // Every other line keeps its count.
    for (const l of result.lines.filter((x) => x.invoiceId !== "R1")) expect(l.expectedCents).toBe(counted(base, l.invoiceId));
  });

  it("never takes a customer's expected receipts below zero", () => {
    const result = position(golden({ payments: [...golden().payments, payment("pay-n-new", "cust-n", "2026-11-02", 40_000)] }));
    // N1 counted 15,000; the other 25,000 of the payment is cash on hand with nothing to offset.
    expect(counted(result, "N1")).toBe(0);
    expect(result.figures.expectedReceiptsCents).toBe(base.figures.expectedReceiptsCents - 15_000);
    expect(result.figures.gapCents).toBe(base.figures.gapCents + 25_000);
  });

  it("takes off only the part of a payment that is not applied", () => {
    const result = position(
      golden({
        payments: [...golden().payments, payment("pay-r-part", "cust-r", "2026-11-02", 50_000)],
        applications: [...golden().applications, applied("app-r-part", "pay-r-part", "R2", 20_000)],
      }),
    );
    // 20,000 pays R2 (not expected by Friday), so 30,000 is left to come off R1.
    expect(counted(result, "R1")).toBe(70_000);
    expect(result.lines.find((l) => l.invoiceId === "R2")?.balanceCents).toBe(30_000);
    expect(result.figures.gapCents).toBe(base.figures.gapCents + 20_000);
  });

  it("leaves the counted lines alone for a payment received on or before the balance date", () => {
    const result = position(golden({ payments: [...golden().payments, payment("pay-r-old", "cust-r", "2026-10-31", 30_000)] }));
    expect(counted(result, "R1")).toBe(100_000);
    expect(result.figures).toEqual(base.figures);
  });
});

describe("a chase counts only the cash the position does not already count", () => {
  // N1 grows to 1,000.00: three days past due, from a customer with nothing paid yet, so the engine
  // counts half of it (500.00) by pay day. The bank balance is set so the short is 800.00.
  const N1_1000 = OPEN_INVOICES.map((i) => (i.id === "N1" ? { ...i, amountCents: c(100_000) } : i));
  const shortBy800 = (over: Partial<CashFridayInput> = {}) =>
    golden({
      settings: { ...SETTINGS, bankBalanceCents: c(205_000) },
      invoices: [...HISTORY.map((h) => h.invoice), ...N1_1000],
      ...over,
    });
  const chaseOf = (r: CashPosition, customerId: string) => {
    const o = r.options.find((x) => x.kind === "collections_chase" && x.subjectId === customerId);
    if (!o || o.kind !== "collections_chase") throw new Error(`no chase for ${customerId}`);
    return o;
  };

  it("nets a 1,000.00 past-due invoice with 500.00 already expected to 500.00, short of an 800.00 short", () => {
    const result = position(shortBy800());
    expect(result.figures.gapCents).toBe(-80_000);
    expect(result.lines.find((l) => l.invoiceId === "N1")).toMatchObject({ status: "counted", expectedCents: 50_000 });
    const chase = chaseOf(result, "cust-n");
    expect([chase.amountCents, chase.newCashCents, chase.coversShort]).toEqual([100_000, 50_000, false]);
    expect(Number.isSafeInteger(chase.newCashCents)).toBe(true);
  });

  it("marks a chase covering when its new cash alone closes the short", () => {
    // L1 at 1,000.00 is stalled, so the engine expects none of it: all of it is new cash.
    const invoices = [
      ...HISTORY.map((h) => h.invoice),
      ...N1_1000.map((i) => (i.id === "L1" ? { ...i, amountCents: c(100_000) } : i)),
    ];
    const result = position(shortBy800({ invoices }));
    expect(result.figures.gapCents).toBe(-80_000);
    const l = chaseOf(result, "cust-l");
    expect([l.amountCents, l.newCashCents, l.coversShort]).toEqual([100_000, 100_000, true]);
    // The same 1,000.00 past due, half of it already expected: not covering.
    const n = chaseOf(result, "cust-n");
    expect([n.amountCents, n.newCashCents, n.coversShort]).toEqual([100_000, 50_000, false]);
  });

  it("takes a payment since the balance date not yet applied off the new cash once", () => {
    // 20,000 received since the balance date, not applied: in cash on hand, off N1's count.
    const payments = [...golden().payments, payment("pay-n-new", "cust-n", "2026-11-02", 20_000)];
    const result = position(shortBy800({ payments }));
    expect(result.figures.gapCents).toBe(-80_000);
    expect(result.lines.find((l) => l.invoiceId === "N1")?.expectedCents).toBe(30_000);
    // 100,000 past due less 30,000 still expected less 20,000 already in hand.
    expect(chaseOf(result, "cust-n").newCashCents).toBe(50_000);
  });

  it("never takes the new cash below zero", () => {
    // Golden N1 (30,000) and 40,000 received since the balance date, not applied: nothing new.
    const result = position(golden({ payments: [...golden().payments, payment("pay-n-new", "cust-n", "2026-11-02", 40_000)] }));
    const chase = chaseOf(result, "cust-n");
    expect([chase.amountCents, chase.newCashCents, chase.coversShort]).toEqual([30_000, 0, false]);
  });
});

describe("payDayFor", () => {
  it("finds the first such weekday after the week ends", () => {
    // Monday to Sunday weeks (Blue Ridge): Friday after Sunday Nov 1.
    expect(payDayFor({ start: "2026-10-26", end: "2026-11-01" }, 5)).toBe("2026-11-06");
    // Sunday to Saturday weeks (Prairie Wind): Friday after Saturday Oct 31.
    expect(payDayFor({ start: "2026-10-25", end: "2026-10-31" }, 5)).toBe("2026-11-06");
    // Pay on Saturday after a week ending Saturday: the next Saturday, never the same day.
    expect(payDayFor({ start: "2026-10-25", end: "2026-10-31" }, 6)).toBe("2026-11-07");
    // Monday after a week ending Sunday.
    expect(payDayFor({ start: "2026-10-26", end: "2026-11-01" }, 1)).toBe("2026-11-02");
  });

  it("keeps the scheduled pay day through that day, then moves to the next one on or after asOf", () => {
    const week = { start: "2026-10-26", end: "2026-11-01" };
    expect(payDayFor(week, 5, "2026-11-02")).toBe("2026-11-06");
    expect(payDayFor(week, 5, "2026-11-06")).toBe("2026-11-06");
    // Saturday Nov 7, the week still open: the next Friday.
    expect(payDayFor(week, 5, "2026-11-07")).toBe("2026-11-13");
    // A Friday past the scheduled one is itself the pay day.
    expect(payDayFor(week, 5, "2026-11-13")).toBe("2026-11-13");
  });

  it("plans for the next pay day when the open week's has passed", () => {
    const result = position(golden(), "2026-11-07");
    expect(result.payDay).toBe("2026-11-13");
  });

  it("refuses a weekday outside 0 to 6", () => {
    expect(() => payDayFor({ start: "2026-10-26", end: "2026-11-01" }, 7)).toThrow(InputError);
    expect(() => payDayFor({ start: "2026-10-26", end: "2026-11-01" }, 2.5)).toThrow(InputError);
  });
});

describe("typicalDaysLate", () => {
  function profile(medianDaysLate: number | null, label: PaymentProfile["label"]): PaymentProfile {
    return {
      customerId: "cust",
      invoices: 1,
      paidCount: medianDaysLate === null ? 0 : 1,
      medianDaysLate,
      lateShareBps: 0,
      paidOver30Late: 0,
      openPast30: 0,
      label,
    };
  }

  it("rounds the median half up, never to negative zero", () => {
    expect(typicalDaysLate(profile(2.5, "mixed"))).toBe(3);
    expect(typicalDaysLate(profile(-1.5, "mixed"))).toBe(-1);
    expect(Object.is(typicalDaysLate(profile(-0.5, "mixed")), 0)).toBe(true);
  });

  it("uses the label's default with nothing paid", () => {
    expect(typicalDaysLate(profile(null, "reliable"))).toBe(0);
    expect(typicalDaysLate(profile(null, "mixed"))).toBe(7);
    expect(typicalDaysLate(profile(null, "repeat_late"))).toBe(35);
  });
});

describe("expectedReceipts for a customer who pays early", () => {
  // Pays 30 days before the due date as a rule, so 30 + 14 grace days would call anything due
  // within the next 16 days late. Not yet due is never stalled: counted, expected today.
  const early: PaymentProfile = {
    customerId: "cust-e",
    invoices: 4,
    paidCount: 4,
    medianDaysLate: -30,
    lateShareBps: 0,
    paidOver30Late: 0,
    openPast30: 0,
    label: "reliable",
  };
  const open = (id: string, dueOn: string) => ({
    invoice: invoice({ id, customerId: "cust-e", amountCents: c(10_000), issuedOn: "2026-10-01", dueOn }),
    balanceCents: c(10_000),
  });

  it("counts an invoice not yet due and stalls it only once it is past due", () => {
    const lines = expectedReceipts(
      [open("E1", "2026-11-10"), open("E2", "2026-11-01")],
      new Map([["cust-e", early]]),
      AS_OF,
      "2026-11-06",
      14,
    );
    expect(lines.map((l) => [l.invoiceId, l.status, l.expectedOn, l.expectedCents])).toEqual([
      ["E1", "counted", "2026-11-02", 10_000],
      ["E2", "stalled", "2026-11-02", 0],
    ]);
  });
});

describe("billsDue and billDeferOption", () => {
  it("counts open bills due by pay day and deferred ones on their new date", () => {
    expect(billsDue(BILLS, "2026-11-06").map((b) => b.id)).toEqual(["b1", "b2", "b3", "b5"]);
  });

  it("breaks a tie on amount by bill reference", () => {
    const tied = [
      bill({ id: "x2", billRef: "BILL-B", amountCents: c(5_000), urgency: "flexible" }),
      bill({ id: "x1", billRef: "BILL-A", amountCents: c(5_000), urgency: "flexible" }),
    ];
    expect(billDeferOption(tied, "2026-11-06", 4_000)).toMatchObject({
      subjectId: "x1",
      deferredTo: "2026-11-13",
      coversShort: true,
    });
  });

  it("has nothing to delay when every bill due is fixed", () => {
    expect(billDeferOption([bill({ id: "f1" })], "2026-11-06", 1)).toBeNull();
  });
});
