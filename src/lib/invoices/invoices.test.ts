import { describe, expect, it } from "vitest";
import type { Param, Queryable } from "../db";
import { impactOf } from "../agent/gateway/store/proposals";
import type { CustomerRecord, Finding, LoadRecord } from "../rules-engine";
import { DEMO_CARRIERS } from "../seed/carriers";
import { centsToDollarsText, dollarsToCents } from "./form-text";
import { OUTCOME_FALLBACK, outcomeLabel, QUEUE_REASON_LABELS } from "./labels";
import { matchWrongInvoiceFinding } from "./match";
import {
  FIRST_INVOICE_NUMBER,
  invoiceNumberOf,
  invoiceNumberPattern,
  invoicePrefixOf,
  nextInvoiceNumber,
  tenantLock,
} from "./number";
import { checkApplications, checkPaymentInput, RECEIVED_WINDOW_DAYS } from "./payment-input";
import { lineSummary, sameLines, splitInvoiceQueue } from "./queue";

// Pure pieces of invoicing and customer payments. Fixed dates only; nothing reads the clock.

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Call = { sql: string; params: Param[] | undefined };

function recorder(rows: (sql: string) => Record<string, unknown>[] = () => []) {
  const calls: Call[] = [];
  const q: Queryable = {
    query: async <T,>(sql: string, params?: Param[]) => {
      calls.push({ sql, params });
      return rows(sql) as T[];
    },
    execute: async () => 0,
  } as unknown as Queryable;
  return { q, calls };
}

describe("invoice numbers", () => {
  it("derives each demo carrier's prefix from its slug", () => {
    for (const c of DEMO_CARRIERS) expect(invoicePrefixOf(c.slug)).toBe(c.prefix);
  });

  it("refuses a slug or prefix outside the allowed shape", () => {
    expect(() => invoicePrefixOf("Blue Ridge")).toThrow(RangeError);
    expect(() => invoicePrefixOf("")).toThrow(RangeError);
    expect(() => invoiceNumberOf("br", 10001)).toThrow(RangeError);
    expect(() => invoiceNumberOf("BR", 0)).toThrow(RangeError);
    expect(() => invoiceNumberOf("BR", 1.5)).toThrow(RangeError);
  });

  it("writes the seed's shape and anchors the pattern at both ends", () => {
    expect(invoiceNumberOf("BR", FIRST_INVOICE_NUMBER)).toBe("BR-INV-10001");
    const re = new RegExp(invoiceNumberPattern("BR"));
    expect(re.test("BR-INV-10001")).toBe(true);
    expect(re.test("BR-INV-10001X")).toBe(false);
    expect(re.test("XBR-INV-10001")).toBe(false);
    expect(re.test("PW-INV-10001")).toBe(false);
  });

  it("takes the tenant lock before reading the highest number, and starts at the first", async () => {
    const empty = recorder((sql) => (sql.includes("max(") ? [{ n: null }] : [{ n: 1 }]));
    expect(await nextInvoiceNumber(empty.q, "BR")).toBe("BR-INV-10001");
    expect(empty.calls[0].sql).toContain("pg_advisory_xact_lock");
    expect(empty.calls[0].params).toEqual(["invoice_number"]);
    expect(empty.calls[1].sql).toContain("max(");

    const some = recorder((sql) => (sql.includes("max(") ? [{ n: "10041" }] : [{ n: 1 }]));
    expect(await nextInvoiceNumber(some.q, "BR")).toBe("BR-INV-10042");
  });

  it("refuses a highest number it cannot read as a whole number", async () => {
    const bad = recorder((sql) => (sql.includes("max(") ? [{ n: "-3" }] : [{ n: 1 }]));
    await expect(nextInvoiceNumber(bad.q, "BR")).rejects.toThrow("unreadable invoice number");
  });

  it("locks per tenant and purpose with the purpose as a parameter", async () => {
    const r = recorder();
    await tenantLock(r.q, "customer_payment");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].sql).toContain("current_tenant_id()");
    expect(r.calls[0].params).toEqual(["customer_payment"]);
  });
});

function load(over: Partial<LoadRecord> & { id: string; loadNumber: string }): LoadRecord {
  return {
    customerId: ID(900),
    driverId: ID(700),
    status: "delivered",
    originCity: "Roanoke",
    originState: "VA",
    destCity: "Columbus",
    destState: "OH",
    pickupOn: "2026-10-12",
    deliveredOn: "2026-10-13",
    deliveredAt: null,
    loadedMiles: 400,
    emptyMiles: 20,
    linehaulCents: 180_000,
    fuelSurchargeCents: 12_000,
    stateMiles: [],
    accessorials: [],
    ...over,
  } as LoadRecord;
}

const CUSTOMER: CustomerRecord = {
  id: ID(900),
  code: "ACME",
  name: "Acme Freight Buyers",
  termsDays: 30,
  city: "Columbus",
  state: "OH",
  detentionFreeMinutes: 120,
  detentionHourlyCents: 5_000,
} as CustomerRecord;

describe("invoice queue split", () => {
  it("puts each delivered load in exactly one list, in load-number order", () => {
    const loads = [
      load({ id: ID(3), loadNumber: "BR-1003", linehaulCents: null }),
      load({ id: ID(1), loadNumber: "BR-1001" }),
      load({ id: ID(2), loadNumber: "BR-1002", customerId: ID(901) }),
      load({ id: ID(4), loadNumber: "BR-1004", customerId: null }),
    ];
    const q = splitInvoiceQueue(loads, [CUSTOMER]);
    expect(q.invoiceable.map((i) => i.load.loadNumber)).toEqual(["BR-1001"]);
    expect(q.invoiceable[0].amountCents).toBe(192_000);
    expect(lineSummary(q.invoiceable[0].lines)).toEqual([
      { kind: "linehaul", amountCents: 180_000 },
      { kind: "fuel_surcharge", amountCents: 12_000 },
    ]);
    expect(q.exceptions.map((e) => [e.load.loadNumber, e.reason])).toEqual([
      ["BR-1002", "missing_customer"],
      ["BR-1003", "missing_rate"],
      ["BR-1004", "missing_customer"],
    ]);
  });

  it("compares line summaries whole, in order", () => {
    const a = [
      { kind: "linehaul" as const, amountCents: 100 },
      { kind: "fuel_surcharge" as const, amountCents: 5 },
    ];
    expect(sameLines(a, [...a])).toBe(true);
    expect(sameLines(a, [a[1], a[0]])).toBe(false);
    expect(sameLines(a, [a[0]])).toBe(false);
    expect(sameLines(a, [a[0], { kind: "fuel_surcharge", amountCents: 6 }])).toBe(false);
  });

  it("has words for every reason the engine refuses a load", () => {
    expect(Object.keys(QUEUE_REASON_LABELS).sort()).toEqual(["missing_customer", "missing_rate", "not_delivered"]);
  });
});

describe("outcome labels", () => {
  it("turns known categories into fixed words and anything else into the fallback", () => {
    expect(outcomeLabel("stale")).toMatch(/changed after this was proposed/);
    expect(outcomeLabel("posted_outside")).toMatch(/already in QuickBooks/);
    expect(outcomeLabel("toString")).toBe(OUTCOME_FALLBACK);
    expect(outcomeLabel("Error: socket hang up")).toBe(OUTCOME_FALLBACK);
    expect(outcomeLabel(null)).toBe(OUTCOME_FALLBACK);
  });
});

describe("proposal impact for the new kinds", () => {
  it("shows an invoice as money coming in and a payment move as no money moving", () => {
    expect(impactOf("invoice_post", 192_000)).toEqual({ amountCents: 192_000, direction: "in" });
    expect(impactOf("payment_reapply", 50_000)).toEqual({ amountCents: 50_000, direction: "none" });
  });
});

describe("wrong-invoice finding match", () => {
  const ids = { paymentId: ID(1), applicationId: ID(2), fromInvoiceId: ID(3), toInvoiceId: ID(4) };
  const finding: Finding = {
    check: "payment_on_wrong_invoice",
    category: "payment_on_wrong_invoice",
    amountCents: 50_000,
    sources: [
      { table: "customer_payments", id: ID(1) },
      { table: "payment_applications", id: ID(2) },
      { table: "invoices", id: ID(3) },
      { table: "invoices", id: ID(4) },
    ],
  } as Finding;

  it("matches only the finding with exactly these four records in order", () => {
    expect(matchWrongInvoiceFinding([finding], ids)).toBe(finding);
    expect(matchWrongInvoiceFinding([finding], { ...ids, toInvoiceId: ID(5) })).toBeNull();
    expect(
      matchWrongInvoiceFinding([finding], { ...ids, fromInvoiceId: ID(4), toInvoiceId: ID(3) }),
    ).toBeNull();
    // A prefix of an id is not the id.
    expect(matchWrongInvoiceFinding([finding], { ...ids, paymentId: ID(1).slice(0, 30) })).toBeNull();
  });

  it("ignores another check's finding and one with no amount", () => {
    expect(matchWrongInvoiceFinding([{ ...finding, check: "invoice_short" } as unknown as Finding], ids)).toBeNull();
    const noAmount = { ...finding };
    delete noAmount.amountCents;
    expect(matchWrongInvoiceFinding([noAmount], ids)).toBeNull();
    expect(matchWrongInvoiceFinding([{ ...finding, sources: finding.sources.slice(0, 3) }], ids)).toBeNull();
  });
});

describe("payment input", () => {
  const today = "2026-10-20";
  const base = {
    customerId: ID(900),
    receivedOn: "2026-10-19",
    amountCents: 100_000,
    method: "check",
    paymentRef: "CHK-20417",
    applications: [
      { invoiceId: ID(10), amountCents: 60_000 },
      { invoiceId: ID(11), amountCents: 40_000 },
    ],
  };

  it("accepts a well-formed payment", () => {
    expect(checkPaymentInput(base, today)).toEqual({ ok: true, input: base });
    expect(checkPaymentInput({ ...base, applications: [] }, today).ok).toBe(true);
  });

  it("refuses a bad shape, an unknown field, a long reference or a control character", () => {
    expect(checkPaymentInput({ ...base, extra: 1 }, today)).toEqual({ ok: false, category: "validation" });
    expect(checkPaymentInput({ ...base, amountCents: 10.5 }, today)).toEqual({ ok: false, category: "validation" });
    expect(checkPaymentInput({ ...base, method: "cash" }, today)).toEqual({ ok: false, category: "validation" });
    expect(checkPaymentInput({ ...base, paymentRef: "A".repeat(22) }, today)).toEqual({
      ok: false,
      category: "validation",
    });
    expect(checkPaymentInput({ ...base, paymentRef: "CHK 1" }, today)).toEqual({ ok: false, category: "validation" });
    expect(checkPaymentInput({ ...base, memo: "line\u0007" }, today)).toEqual({ ok: false, category: "validation" });
  });

  it("keeps the received date between the window's start and today", () => {
    expect(checkPaymentInput({ ...base, receivedOn: "2026-10-21" }, today)).toEqual({
      ok: false,
      category: "validation",
    });
    expect(checkPaymentInput({ ...base, receivedOn: today }, today).ok).toBe(true);
    expect(RECEIVED_WINDOW_DAYS).toBe(365);
    expect(checkPaymentInput({ ...base, receivedOn: "2025-10-20" }, today).ok).toBe(true);
    expect(checkPaymentInput({ ...base, receivedOn: "2025-10-19" }, today)).toEqual({
      ok: false,
      category: "validation",
    });
  });

  it("refuses an amount over the cap, the same invoice twice, and more applied than received", () => {
    expect(checkPaymentInput({ ...base, amountCents: 5_000_001, applications: [] }, today)).toEqual({
      ok: false,
      category: "limit",
    });
    expect(
      checkPaymentInput(
        { ...base, applications: [base.applications[0], { invoiceId: ID(10), amountCents: 1 }] },
        today,
      ),
    ).toEqual({ ok: false, category: "validation" });
    expect(checkPaymentInput({ ...base, amountCents: 99_999 }, today)).toEqual({ ok: false, category: "over_applied" });
  });
});

describe("applications against open invoices", () => {
  const invoices = [
    { id: ID(10), customerId: ID(900), status: "open", amountCents: 60_000, appliedCents: 0 },
    { id: ID(11), customerId: ID(900), status: "partially_paid", amountCents: 80_000, appliedCents: 50_000 },
    { id: ID(12), customerId: ID(901), status: "open", amountCents: 10_000, appliedCents: 0 },
    { id: ID(13), customerId: ID(900), status: "paid", amountCents: 10_000, appliedCents: 10_000 },
  ];

  it("allows up to each invoice's balance on the customer's own open invoices", () => {
    expect(
      checkApplications(
        ID(900),
        [
          { invoiceId: ID(10), amountCents: 60_000 },
          { invoiceId: ID(11), amountCents: 30_000 },
        ],
        invoices,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses another customer's invoice, an unknown one, a paid one, and more than the balance", () => {
    expect(checkApplications(ID(900), [{ invoiceId: ID(12), amountCents: 1 }], invoices)).toEqual({
      ok: false,
      category: "validation",
    });
    expect(checkApplications(ID(900), [{ invoiceId: ID(99), amountCents: 1 }], invoices)).toEqual({
      ok: false,
      category: "validation",
    });
    expect(checkApplications(ID(900), [{ invoiceId: ID(13), amountCents: 1 }], invoices)).toEqual({
      ok: false,
      category: "over_applied",
    });
    expect(checkApplications(ID(900), [{ invoiceId: ID(11), amountCents: 30_001 }], invoices)).toEqual({
      ok: false,
      category: "over_applied",
    });
  });
});

describe("dollar text", () => {
  it("reads typed dollars as whole cents, never through a float", () => {
    expect(dollarsToCents("1250")).toBe(125_000);
    expect(dollarsToCents("1,250.5")).toBe(125_050);
    expect(dollarsToCents("$0.07")).toBe(7);
    expect(dollarsToCents(" 19.99 ")).toBe(1_999);
    expect(dollarsToCents("0.1")).toBe(10);
  });

  it("refuses anything that is not plain dollars and cents", () => {
    for (const bad of ["", "1.234", "-5", "1e3", "12,34", "1,2345", "abc", "1.", ".5", "1234567890"]) {
      expect(dollarsToCents(bad)).toBeNull();
    }
  });

  it("writes cents back as text the reader accepts", () => {
    expect(centsToDollarsText(125_050)).toBe("1250.50");
    expect(centsToDollarsText(7)).toBe("0.07");
    expect(dollarsToCents(centsToDollarsText(987_654))).toBe(987_654);
    expect(() => centsToDollarsText(-1)).toThrow(RangeError);
  });
});
