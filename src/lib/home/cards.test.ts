import { describe, expect, it } from "vitest";
import { DbError } from "@/lib/db";
import type { InvoiceListRow } from "@/lib/invoices/views";
import type { SettlementListRow } from "@/lib/settlements/views";
import { ForbiddenError } from "@/lib/tenant/context";
import { owedOf, paydayOf } from "./cards";
import { loaded, wholeNumber } from "./loaded";

// Home's card figures, counted from the rows the Settlements and Invoices pages read, and the
// guard that turns a failed read into an unavailable card.

const stub = (over: Partial<SettlementListRow>): SettlementListRow => ({
  id: "s",
  driverId: "d",
  driverCode: "BR-D01",
  driverName: "Ana Rivera",
  grossCents: 100_000,
  deductionsCents: 10_000,
  netCents: 90_000,
  exceptionCount: 0,
  exceptions: [],
  status: "draft",
  parkedReason: null,
  parkedLabel: null,
  proposalId: null,
  proposalStatus: null,
  auditor: null,
  auditorAgrees: null,
  clean: true,
  ...over,
});

const invoice = (over: Partial<InvoiceListRow>): InvoiceListRow => ({
  id: "i",
  invoiceNumber: "INV-1",
  customerId: "c",
  customerName: "Harbor Foods",
  loadId: null,
  status: "open",
  amountCents: 50_000,
  balanceCents: 50_000,
  issuedOn: "2026-10-20",
  dueOn: "2026-11-19",
  bucket: "current",
  posted: true,
  ...over,
});

const PERIOD = { id: "p", start: "2026-11-02", end: "2026-11-08", status: "open" };

describe("paydayOf", () => {
  it("counts where each paystub stands and adds their net pay", () => {
    const rows = [
      stub({ proposalStatus: "proposed", netCents: 10_001 }),
      stub({ proposalStatus: "proposed", exceptionCount: 2, netCents: 20_002 }),
      stub({ status: "approved", proposalStatus: "approved", netCents: 30_003 }),
      stub({ status: "paid", netCents: 40_004 }),
      stub({ parkedReason: "line_amount_changed", netCents: 50_005 }),
    ];
    expect(paydayOf({ period: PERIOD, rows })).toEqual({
      period: PERIOD,
      paystubs: 5,
      waiting: 2,
      approved: 1,
      paid: 1,
      held: 1,
      problems: 1,
      netCents: 150_015,
    });
  });

  it("reads a week with no paystubs as zeros, and no week as no period", () => {
    expect(paydayOf({ period: PERIOD, rows: [] })).toMatchObject({ period: PERIOD, paystubs: 0, netCents: 0 });
    expect(paydayOf({ period: null, rows: [] }).period).toBeNull();
  });
});

describe("owedOf", () => {
  it("adds open balances and the part past due, leaving paid invoices out", () => {
    const rows = [
      invoice({ balanceCents: 10_000 }),
      invoice({ balanceCents: 20_000, bucket: "1_30" }),
      invoice({ balanceCents: 30_000, bucket: "over_90" }),
      invoice({ status: "paid", balanceCents: 0, bucket: null }),
    ];
    expect(owedOf(rows)).toEqual({ invoices: 3, owedCents: 60_000, late: 2, lateCents: 50_000 });
  });

  it("reads no open invoices as nothing owed", () => {
    expect(owedOf([])).toEqual({ invoices: 0, owedCents: 0, late: 0, lateCents: 0 });
  });
});

describe("loaded", () => {
  it("passes a read's value through", async () => {
    expect(await loaded("test", async () => 7)).toEqual({ ok: true, value: 7 });
  });

  it("turns a database or membership failure into an unavailable card", async () => {
    const errors: unknown[] = [];
    const log = (...args: unknown[]) => errors.push(args);
    const original = console.error;
    console.error = log;
    try {
      expect(await loaded("test", () => Promise.reject(new DbError("timeout")))).toEqual({ ok: false });
      expect(await loaded("test", () => Promise.reject(new ForbiddenError()))).toEqual({ ok: false });
    } finally {
      console.error = original;
    }
    // Only the error's name is logged, never its text.
    expect(errors).toEqual([
      ["home card read failed:", "test", "DbError"],
      ["home card read failed:", "test", "ForbiddenError"],
    ]);
  });

  it("lets anything else through, so the sign-in redirect still happens", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    await expect(loaded("test", () => Promise.reject(redirect))).rejects.toBe(redirect);
  });
});

describe("wholeNumber", () => {
  it("takes whole counts and cents, as numbers or digit strings", () => {
    expect(wholeNumber(0)).toBe(0);
    expect(wholeNumber(12_345)).toBe(12_345);
    expect(wholeNumber("150015")).toBe(150_015);
  });

  it.each([[-1], [1.5], ["1.5"], ["12a"], [""], [null], [undefined], [Number.MAX_SAFE_INTEGER + 1], ["9007199254740993"]])(
    "refuses %s as a read that cannot be trusted",
    (value) => {
      expect(() => wholeNumber(value)).toThrow(DbError);
    },
  );
});
