import { describe, expect, it } from "vitest";
import { receivablesInputOf } from "../data/records";
import { DEMO_ANCHOR } from "../seed/anchor";
import { DEMO_CARRIERS } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { collectionStage, collectionTone, planCollections } from "./collections";
import { c } from "./test-records";
import {
  InputError,
  type CustomerPaymentRecord,
  type InvoiceRecord,
  type PaymentApplicationRecord,
  type ReceivablesInput,
} from "./types";

const AS_OF = "2026-11-02";

const invoice = (id: string, customerId: string, amount: number, issuedOn: string, dueOn: string): InvoiceRecord => ({
  id,
  source: "load",
  loadId: `load-${id}`,
  customerId,
  invoiceNumber: `INV-${id}`,
  amountCents: c(amount * 100),
  issuedOn,
  dueOn,
  status: "open",
  paidOn: null,
  qboId: null,
});

const payment = (id: string, customerId: string, amount: number, receivedOn: string): CustomerPaymentRecord => ({
  id,
  customerId,
  receivedOn,
  amountCents: c(amount * 100),
  method: "ach",
  paymentRef: `ACH-${id}`,
  source: "seed",
  memo: null,
  qboId: null,
});

const apply = (id: string, paymentId: string, invoiceId: string, amount: number): PaymentApplicationRecord => ({
  id,
  paymentId,
  invoiceId,
  amountCents: c(amount * 100),
});

const input = (
  invoices: InvoiceRecord[],
  payments: CustomerPaymentRecord[] = [],
  applications: PaymentApplicationRecord[] = [],
): ReceivablesInput => ({ invoices, payments, applications, asOf: AS_OF });

describe("collectionStage", () => {
  it("is 30 below 60 days, 60 below 90 and 90 from 90 on", () => {
    expect(collectionStage(30)).toBe("30");
    expect(collectionStage(59)).toBe("30");
    expect(collectionStage(60)).toBe("60");
    expect(collectionStage(89)).toBe("60");
    expect(collectionStage(90)).toBe("90");
    expect(collectionStage(400)).toBe("90");
  });

  it("refuses a day count that is not a whole, non-negative number", () => {
    expect(() => collectionStage(-1)).toThrow(InputError);
    expect(() => collectionStage(30.5)).toThrow(InputError);
    expect(() => collectionStage(Number.NaN)).toThrow(InputError);
  });
});

describe("collectionTone", () => {
  it("is friendly for a reliable customer at every stage", () => {
    expect(collectionTone("reliable", "30")).toBe("friendly");
    expect(collectionTone("reliable", "60")).toBe("friendly");
    expect(collectionTone("reliable", "90")).toBe("friendly");
  });

  it("is friendly then direct for a mixed customer", () => {
    expect(collectionTone("mixed", "30")).toBe("friendly");
    expect(collectionTone("mixed", "60")).toBe("direct");
    expect(collectionTone("mixed", "90")).toBe("direct");
  });

  it("is direct then firm for a repeat late customer", () => {
    expect(collectionTone("repeat_late", "30")).toBe("direct");
    expect(collectionTone("repeat_late", "60")).toBe("firm");
    expect(collectionTone("repeat_late", "90")).toBe("firm");
  });

  it("refuses a label it does not know", () => {
    expect(() => collectionTone("unknown" as never, "30")).toThrow(InputError);
  });
});

describe("planCollections", () => {
  it("picks C03's three planted invoices at stages 30, 60 and 90 and skips C01's 12-day one", () => {
    const plan = buildCarrierPlan(DEMO_CARRIERS[0], DEMO_ANCHOR);
    const planted = plan.planted.collections;
    expect(planted.map((p) => p.daysLate).sort((a, b) => a - b)).toEqual([12, 34, 62, 97]);
    const late = planted.filter((p) => p.daysLate >= 30);
    const early = planted.filter((p) => p.daysLate < 30);
    expect(new Set(late.map((p) => p.customerId)).size).toBe(1);

    const candidates = planCollections(receivablesInputOf(plan.rows, DEMO_ANCHOR), [late[0].customerId], 30);
    for (const p of late) {
      const found = candidates.find((k) => k.invoiceId === p.invoiceId);
      expect(found, `planted invoice ${p.daysLate} days late`).toBeDefined();
      expect(found?.daysLate).toBe(p.daysLate);
      expect(found?.stage).toBe(collectionStage(p.daysLate));
    }
    expect(late.map((p) => candidates.find((k) => k.invoiceId === p.invoiceId)?.stage).sort()).toEqual([
      "30",
      "60",
      "90",
    ]);

    const everyone = planCollections(receivablesInputOf(plan.rows, DEMO_ANCHOR), null, 30);
    for (const p of early) expect(everyone.some((k) => k.invoiceId === p.invoiceId)).toBe(false);
    expect(everyone.every((k) => k.daysLate >= 30 && k.balanceCents > 0)).toBe(true);
    expect(everyone.every((k, i) => i === 0 || everyone[i - 1].daysLate >= k.daysLate)).toBe(true);
  });

  it("gives a repeat late customer direct at 30 and firm at 60", () => {
    const invoices = [
      // Two paid 40 days late make the customer repeat_late.
      invoice("p1", "cust-r", 1000, "2026-06-01", "2026-07-01"),
      invoice("p2", "cust-r", 1000, "2026-06-15", "2026-07-15"),
      invoice("o30", "cust-r", 2480, "2026-08-30", "2026-09-29"),
      invoice("o60", "cust-r", 1960, "2026-08-02", "2026-09-01"),
    ];
    const payments = [payment("pay1", "cust-r", 1000, "2026-08-10"), payment("pay2", "cust-r", 1000, "2026-08-24")];
    const applications = [apply("a1", "pay1", "p1", 1000), apply("a2", "pay2", "p2", 1000)];
    const out = planCollections(input(invoices, payments, applications), null, 30);
    expect(out.map((k) => [k.invoiceId, k.daysLate, k.stage, k.tone, k.profile.label])).toEqual([
      ["o60", 62, "60", "firm", "repeat_late"],
      ["o30", 34, "30", "direct", "repeat_late"],
    ]);
    expect(out[0].sources).toEqual([
      { table: "invoices", id: "o60" },
      { table: "customers", id: "cust-r" },
    ]);
  });

  it("gives a reliable customer a friendly reminder at 90", () => {
    const invoices = [
      // Issued over 180 days ago, so it is outside the profile window but still owed.
      invoice("old", "cust-g", 3120, "2026-04-01", "2026-05-01"),
      invoice("g1", "cust-g", 1000, "2026-07-01", "2026-07-31"),
      invoice("g2", "cust-g", 1000, "2026-08-01", "2026-08-31"),
    ];
    const payments = [payment("pg1", "cust-g", 1000, "2026-07-30"), payment("pg2", "cust-g", 1000, "2026-08-30")];
    const applications = [apply("b1", "pg1", "g1", 1000), apply("b2", "pg2", "g2", 1000)];
    const out = planCollections(input(invoices, payments, applications), null, 30);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      invoiceId: "old",
      stage: "90",
      tone: "friendly",
      amountCents: 312000,
      balanceCents: 312000,
      dueOn: "2026-05-01",
    });
    expect(out[0].profile.label).toBe("reliable");
  });

  it("follows the money applied, not the stored status, and skips void and paid invoices", () => {
    const voided = { ...invoice("v", "cust-a", 500, "2026-07-01", "2026-08-01"), status: "void" as const };
    const paid = { ...invoice("paid", "cust-a", 500, "2026-07-01", "2026-08-01"), status: "open" as const };
    const part = { ...invoice("part", "cust-a", 900, "2026-07-01", "2026-08-01"), status: "paid" as const };
    const out = planCollections(
      input(
        [voided, paid, part],
        [payment("x", "cust-a", 800, "2026-08-20")],
        [apply("ax", "x", "paid", 500), apply("ay", "x", "part", 300)],
      ),
      null,
      30,
    );
    expect(out.map((k) => [k.invoiceId, k.balanceCents])).toEqual([["part", 60000]]);
  });

  it("keeps only the customers asked for and only invoices at least the minimum days late", () => {
    const invoices = [
      invoice("a", "cust-a", 100, "2026-08-01", "2026-09-01"),
      invoice("b", "cust-b", 100, "2026-08-01", "2026-09-01"),
      invoice("c", "cust-a", 100, "2026-09-05", "2026-10-05"),
    ];
    expect(planCollections(input(invoices), ["cust-b"], 30).map((k) => k.invoiceId)).toEqual(["b"]);
    expect(planCollections(input(invoices), null, 30).map((k) => k.invoiceId)).toEqual(["a", "b"]);
    expect(planCollections(input(invoices), null, 28).map((k) => k.invoiceId)).toEqual(["a", "b", "c"]);
    expect(planCollections(input(invoices), [], 1)).toEqual([]);
  });

  it("refuses a minimum that is not a whole number of days", () => {
    expect(() => planCollections(input([]), null, 0)).toThrow(InputError);
    expect(() => planCollections(input([]), null, 1.5)).toThrow(InputError);
  });
});
