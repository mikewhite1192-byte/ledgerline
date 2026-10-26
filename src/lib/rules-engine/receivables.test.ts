import { describe, expect, it } from "vitest";
import { localDateOf } from "../time/local-date";
import {
  ageReceivables,
  agingBucket,
  findPaymentOnWrongInvoice,
  invoiceStatus,
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

  it("gives one finding per application on an overapplied invoice", () => {
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
      {
        check: "payment_on_wrong_invoice",
        category: "invoice_overapplied",
        amountCents: 48_000,
        sources: [
          { table: "customer_payments", id: "p0" },
          { table: "payment_applications", id: "a0" },
          { table: "invoices", id: "y" },
        ],
      },
    ]);
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
