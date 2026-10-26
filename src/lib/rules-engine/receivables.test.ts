import { describe, expect, it } from "vitest";
import { localDateOf } from "../time/local-date";
import {
  ageReceivables,
  agingBucket,
  findPaymentOnWrongInvoice,
  invoiceStatus,
  paymentProfile,
} from "./receivables";
import { c } from "./test-records";
import {
  InputError,
  type CustomerPaymentRecord,
  type InvoiceRecord,
  type PaymentApplicationRecord,
  type ReceivablesInput,
} from "./types";

const AS_OF = "2026-11-02";

const invoice = (
  id: string,
  amount: number,
  dueOn: string,
  more: Partial<InvoiceRecord> = {},
): InvoiceRecord => ({
  id,
  source: "load",
  loadId: `load-${id}`,
  customerId: "cust-a",
  invoiceNumber: `INV-${id}`,
  amountCents: c(amount),
  issuedOn: "2026-09-01",
  dueOn,
  status: "open",
  paidOn: null,
  qboId: null,
  ...more,
});

const payment = (id: string, amount: number, customerId = "cust-a"): CustomerPaymentRecord => ({
  id,
  customerId,
  receivedOn: "2026-10-28",
  amountCents: c(amount),
  method: "ach",
  paymentRef: `ACH-${id}`,
  source: "seed",
  memo: null,
  qboId: null,
});

const apply = (id: string, paymentId: string, invoiceId: string, amount: number) =>
  ({ id, paymentId, invoiceId, amountCents: c(amount) }) as PaymentApplicationRecord;

describe("invoiceStatus", () => {
  it("follows the money applied", () => {
    expect(invoiceStatus(10_000, 0)).toEqual({
      status: "open",
      balanceCents: 10_000,
      overappliedCents: 0,
    });
    expect(invoiceStatus(10_000, 2_500)).toEqual({
      status: "partially_paid",
      balanceCents: 7_500,
      overappliedCents: 0,
    });
    expect(invoiceStatus(10_000, 10_000)).toEqual({
      status: "paid",
      balanceCents: 0,
      overappliedCents: 0,
    });
    expect(invoiceStatus(10_000, 12_000)).toEqual({
      status: "paid",
      balanceCents: 0,
      overappliedCents: 2_000,
    });
  });

  it("refuses a zero amount, negative or fractional applied cents", () => {
    expect(() => invoiceStatus(0, 0)).toThrow(InputError);
    expect(() => invoiceStatus(10_000, -1)).toThrow(InputError);
    expect(() => invoiceStatus(10_000, 1.5)).toThrow();
  });
});

describe("agingBucket", () => {
  it.each([
    ["2026-11-09", "current"],
    ["2026-11-02", "current"],
    ["2026-11-01", "1_30"],
    ["2026-10-03", "1_30"],
    ["2026-10-02", "31_60"],
    ["2026-09-03", "31_60"],
    ["2026-09-02", "61_90"],
    ["2026-08-04", "61_90"],
    ["2026-08-03", "over_90"],
    ["2025-12-01", "over_90"],
  ])("puts an invoice due %s in %s on 2026-11-02", (dueOn, bucket) => {
    expect(agingBucket(dueOn, AS_OF)).toBe(bucket);
  });

  it("ages against the tenant's own date", () => {
    // 03:30 UTC on Nov 3 is still Nov 2 in New York and Chicago.
    const instant = "2026-11-03T03:30:00Z";
    expect(agingBucket("2026-11-02", localDateOf(instant, "America/New_York"))).toBe("current");
    expect(agingBucket("2026-11-02", localDateOf(instant, "America/Chicago"))).toBe("current");
    expect(agingBucket("2026-11-02", localDateOf("2026-11-03T06:00:00Z", "America/Chicago"))).toBe(
      "1_30",
    );
  });

  it("refuses a date that is not a date", () => {
    expect(() => agingBucket("2026-13-01", AS_OF)).toThrow();
    expect(() => agingBucket("2026-11-02", "today")).toThrow();
  });
});

describe("ageReceivables", () => {
  it("totals open balances by customer and bucket, skipping void and settled invoices", () => {
    const input: ReceivablesInput = {
      invoices: [
        invoice("i1", 10_000, "2026-11-10"),
        invoice("i2", 20_000, "2026-10-20"),
        invoice("i3", 30_000, "2026-10-20", { customerId: "cust-b" }),
        invoice("i4", 40_000, "2026-07-01", { status: "void" }),
        invoice("i5", 5_000, "2026-07-01", { status: "paid" }),
      ],
      payments: [payment("p1", 12_500)],
      applications: [apply("a1", "p1", "i2", 7_500), apply("a2", "p1", "i5", 5_000)],
      asOf: AS_OF,
    };
    const out = ageReceivables(input);
    expect(out.totals).toEqual({
      current: 10_000,
      "1_30": 42_500,
      "31_60": 0,
      "61_90": 0,
      over_90: 0,
    });
    expect(out.byCustomer).toEqual([
      {
        customerId: "cust-a",
        buckets: { current: 10_000, "1_30": 12_500, "31_60": 0, "61_90": 0, over_90: 0 },
      },
      {
        customerId: "cust-b",
        buckets: { current: 0, "1_30": 30_000, "31_60": 0, "61_90": 0, over_90: 0 },
      },
    ]);
  });
});

describe("findPaymentOnWrongInvoice", () => {
  // P paid 48,000, X's amount exactly, but was applied in full to Y (26,400).
  const planted = (): ReceivablesInput => ({
    invoices: [
      invoice("y", 26_400, "2026-10-15"),
      invoice("x", 48_000, "2026-10-20"),
      invoice("z", 48_000, "2026-10-25", { customerId: "cust-b" }),
    ],
    payments: [payment("p", 48_000)],
    applications: [apply("a", "p", "y", 48_000)],
    asOf: AS_OF,
  });

  it("finds the payment put on the wrong invoice and names all four records", () => {
    expect(findPaymentOnWrongInvoice(planted())).toEqual([
      {
        check: "payment_on_wrong_invoice",
        category: "payment_on_wrong_invoice",
        amountCents: 48_000,
        sources: [
          { table: "customer_payments", id: "p" },
          { table: "payment_applications", id: "a" },
          { table: "invoices", id: "y" },
          { table: "invoices", id: "x" },
        ],
      },
    ]);
  });

  it("never blames the invoice's own payment for an excess the wrong payment explains", () => {
    // Y's own 26,400 is on it too; the whole 48,000 excess is P's, already found.
    const input = planted();
    input.payments.push(payment("p0", 26_400));
    input.applications.push(apply("a0", "p0", "y", 26_400));
    expect(findPaymentOnWrongInvoice(input)).toEqual([
      {
        check: "payment_on_wrong_invoice",
        category: "payment_on_wrong_invoice",
        amountCents: 48_000,
        sources: [
          { table: "customer_payments", id: "p" },
          { table: "payment_applications", id: "a" },
          { table: "invoices", id: "y" },
          { table: "invoices", id: "x" },
        ],
      },
    ]);
  });

  it("reports only what the wrong payment does not explain, on the last payment received", () => {
    // Y's own 26,400 came first, then P's 48,000 (meant for X), then 5,000 with no target:
    // 53,000 over, 48,000 explained, 5,000 left on the last payment.
    const input = planted();
    input.payments.push({ ...payment("p0", 26_400), receivedOn: "2026-10-01" }, payment("p3", 5_000));
    input.applications.push(apply("a0", "p0", "y", 26_400), apply("a3", "p3", "y", 5_000));
    expect(findPaymentOnWrongInvoice(input)).toEqual([
      {
        check: "payment_on_wrong_invoice",
        category: "payment_on_wrong_invoice",
        amountCents: 48_000,
        sources: [
          { table: "customer_payments", id: "p" },
          { table: "payment_applications", id: "a" },
          { table: "invoices", id: "y" },
          { table: "invoices", id: "x" },
        ],
      },
      {
        check: "payment_on_wrong_invoice",
        category: "invoice_overapplied",
        amountCents: 5_000,
        sources: [
          { table: "customer_payments", id: "p3" },
          { table: "payment_applications", id: "a3" },
          { table: "invoices", id: "y" },
        ],
      },
    ]);
  });

  it("counts the excess once for two applications with no target, on the later payment", () => {
    // 25,000 on 10-20 then 20,000 on 10-28 against 30,000: 15,000 over, once, on the later one
    // (p1, though it sorts first by id).
    const input: ReceivablesInput = {
      invoices: [invoice("y", 30_000, "2026-10-15"), invoice("x", 48_000, "2026-10-20")],
      payments: [payment("p1", 20_000), { ...payment("p2", 25_000), receivedOn: "2026-10-20" }],
      applications: [apply("a1", "p1", "y", 20_000), apply("a2", "p2", "y", 25_000)],
      asOf: AS_OF,
    };
    const want = [
      {
        check: "payment_on_wrong_invoice",
        category: "invoice_overapplied",
        amountCents: 15_000,
        sources: [
          { table: "customer_payments", id: "p1" },
          { table: "payment_applications", id: "a1" },
          { table: "invoices", id: "y" },
        ],
      },
    ];
    expect(findPaymentOnWrongInvoice(input)).toEqual(want);
    const reversed: ReceivablesInput = {
      ...input,
      payments: [...input.payments].reverse(),
      applications: [...input.applications].reverse(),
    };
    expect(findPaymentOnWrongInvoice(reversed)).toEqual(want);
  });

  it("gives the same findings whatever order the records arrive in", () => {
    const input = planted();
    input.payments.push(payment("p0", 26_400));
    input.applications.push(apply("a0", "p0", "y", 26_400));
    const reversed: ReceivablesInput = {
      ...input,
      invoices: [...input.invoices].reverse(),
      payments: [...input.payments].reverse(),
      applications: [...input.applications].reverse(),
    };
    expect(findPaymentOnWrongInvoice(reversed)).toEqual(findPaymentOnWrongInvoice(input));
  });

  it("finds nothing when every payment sits on its own invoice", () => {
    const input: ReceivablesInput = {
      invoices: [invoice("y", 32_000, "2026-10-15"), invoice("x", 48_000, "2026-10-20")],
      payments: [payment("p0", 32_000), payment("p", 48_000)],
      applications: [apply("a0", "p0", "y", 32_000), apply("a", "p", "x", 48_000)],
      asOf: AS_OF,
    };
    expect(findPaymentOnWrongInvoice(input)).toEqual([]);
  });

  it("finds nothing for a partial payment", () => {
    const input: ReceivablesInput = {
      invoices: [invoice("y", 32_000, "2026-10-15"), invoice("x", 20_000, "2026-10-20")],
      payments: [payment("p", 20_000)],
      applications: [apply("a", "p", "y", 20_000)],
      asOf: AS_OF,
    };
    expect(findPaymentOnWrongInvoice(input)).toEqual([]);
  });

  it("reports an overapplied invoice with no likely target as overapplied", () => {
    const input: ReceivablesInput = {
      invoices: [
        invoice("y", 32_000, "2026-10-15"),
        invoice("x", 48_000, "2026-10-20", { customerId: "cust-b" }),
        invoice("v", 40_000, "2026-10-20", { status: "void" }),
      ],
      payments: [payment("p", 40_000)],
      applications: [apply("a", "p", "y", 40_000)],
      asOf: AS_OF,
    };
    expect(findPaymentOnWrongInvoice(input)).toEqual([
      {
        check: "payment_on_wrong_invoice",
        category: "invoice_overapplied",
        amountCents: 8_000,
        sources: [
          { table: "customer_payments", id: "p" },
          { table: "payment_applications", id: "a" },
          { table: "invoices", id: "y" },
        ],
      },
    ]);
  });

  it("refuses an application whose payment is missing", () => {
    const input: ReceivablesInput = {
      invoices: [invoice("y", 32_000, "2026-10-15")],
      payments: [],
      applications: [apply("a", "p", "y", 40_000)],
      asOf: AS_OF,
    };
    expect(() => findPaymentOnWrongInvoice(input)).toThrow(InputError);
  });
});

describe("paymentProfile", () => {
  // One invoice of 10,000 cents due on dueOn, paid in full on paidOn (null: not paid).
  const history = (rows: [dueOn: string, paidOn: string | null][], customerId = "cust-a") => {
    const out: ReceivablesInput = { invoices: [], payments: [], applications: [], asOf: AS_OF };
    rows.forEach(([dueOn, paidOn], k) => {
      const id = `${customerId}-${k}`;
      out.invoices.push(invoice(id, 10_000, dueOn, { customerId, issuedOn: "2026-07-01" }));
      if (paidOn === null) return;
      out.payments.push({ ...payment(`p-${id}`, 10_000, customerId), receivedOn: paidOn });
      out.applications.push(apply(`a-${id}`, `p-${id}`, id, 10_000));
    });
    return out;
  };

  it("reads a customer with one in five paid a few days late as reliable", () => {
    const input = history([
      ["2026-08-01", "2026-07-30"],
      ["2026-08-15", "2026-08-15"],
      ["2026-09-01", "2026-09-04"],
      ["2026-09-15", "2026-09-10"],
      ["2026-10-01", "2026-09-30"],
    ]);
    expect(paymentProfile("cust-a", input, AS_OF)).toEqual({
      customerId: "cust-a",
      invoices: 5,
      paidCount: 5,
      medianDaysLate: -1,
      lateShareBps: 2000,
      paidOver30Late: 0,
      openPast30: 0,
      label: "reliable",
    });
  });

  it("reads half paid late as repeat late", () => {
    const input = history([
      ["2026-08-01", "2026-08-05"],
      ["2026-09-01", "2026-09-01"],
    ]);
    const profile = paymentProfile("cust-a", input, AS_OF);
    expect([profile.lateShareBps, profile.medianDaysLate, profile.label]).toEqual([
      5000,
      2,
      "repeat_late",
    ]);
  });

  it("reads two paid more than 30 days late as repeat late, even when most are on time", () => {
    const input = history([
      ["2026-07-10", "2026-08-11"],
      ["2026-07-20", "2026-09-05"],
      ["2026-08-01", "2026-08-01"],
      ["2026-08-15", "2026-08-14"],
      ["2026-09-01", "2026-09-01"],
      ["2026-09-15", "2026-09-15"],
    ]);
    const profile = paymentProfile("cust-a", input, AS_OF);
    expect([profile.paidOver30Late, profile.lateShareBps, profile.label]).toEqual([
      2,
      3333,
      "repeat_late",
    ]);
  });

  it("reads two invoices open more than 30 days past due as repeat late", () => {
    const input = history([
      ["2026-09-01", null],
      ["2026-10-02", null],
      ["2026-10-01", "2026-10-01"],
    ]);
    const profile = paymentProfile("cust-a", input, AS_OF);
    expect([profile.openPast30, profile.paidCount, profile.label]).toEqual([2, 1, "repeat_late"]);
  });

  it("reads one invoice 31 days late among on-time ones as mixed, not reliable", () => {
    const input = history([
      ["2026-08-01", "2026-09-01"],
      ...Array.from({ length: 9 }, (): [string, string] => ["2026-09-01", "2026-08-30"]),
    ]);
    const profile = paymentProfile("cust-a", input, AS_OF);
    expect([profile.lateShareBps, profile.paidOver30Late, profile.label]).toEqual([
      1000,
      1,
      "mixed",
    ]);
  });

  it("counts an invoice open exactly 30 days past due as not yet past 30", () => {
    const input = history([
      ["2026-10-03", null],
      ["2026-10-01", "2026-10-01"],
    ]);
    const profile = paymentProfile("cust-a", input, AS_OF);
    expect([profile.openPast30, profile.label]).toEqual([0, "reliable"]);
  });

  it("counts a part-paid invoice as open, not paid", () => {
    const input = history([["2026-09-01", null]]);
    input.payments.push({ ...payment("p-part", 4_000), receivedOn: "2026-09-01" });
    input.applications.push(apply("a-part", "p-part", "cust-a-0", 4_000));
    const profile = paymentProfile("cust-a", input, AS_OF);
    expect([profile.paidCount, profile.openPast30, profile.label]).toEqual([0, 1, "mixed"]);
  });

  it("dates a paid invoice by the last payment applied to it", () => {
    const input = history([["2026-09-01", null]]);
    input.payments.push(
      { ...payment("p1", 5_000), receivedOn: "2026-08-25" },
      { ...payment("p2", 5_000), receivedOn: "2026-09-11" },
    );
    input.applications.push(
      apply("a1", "p1", "cust-a-0", 5_000),
      apply("a2", "p2", "cust-a-0", 5_000),
    );
    expect(paymentProfile("cust-a", input, AS_OF).medianDaysLate).toBe(10);
  });

  it("leaves out other customers, void invoices and anything outside the 180 days", () => {
    const input = history([["2026-09-01", "2026-09-01"]]);
    const other = history([["2026-09-01", null]], "cust-b");
    input.invoices.push(
      ...other.invoices,
      invoice("void", 10_000, "2026-09-01", { status: "void", issuedOn: "2026-08-01" }),
      invoice("old", 10_000, "2026-05-01", { issuedOn: "2026-05-05" }),
      invoice("today", 10_000, "2026-12-02", { issuedOn: AS_OF }),
      invoice("edge", 10_000, "2026-06-01", { issuedOn: "2026-05-06" }),
    );
    const profile = paymentProfile("cust-a", input, AS_OF);
    // edge: issued 180 days before asOf, so it counts, open well past due.
    expect([profile.invoices, profile.paidCount, profile.openPast30]).toEqual([2, 1, 1]);
  });

  it("reads a customer with nothing paid yet as mixed", () => {
    const profile = paymentProfile("cust-a", history([]), AS_OF);
    const { paidCount, medianDaysLate, lateShareBps, label } = profile;
    expect([paidCount, medianDaysLate, lateShareBps, label]).toEqual([0, null, 0, "mixed"]);
  });

  it("refuses an application whose payment is missing", () => {
    const input = history([["2026-09-01", "2026-09-01"]]);
    input.payments = [];
    expect(() => paymentProfile("cust-a", input, AS_OF)).toThrow(InputError);
  });
});
