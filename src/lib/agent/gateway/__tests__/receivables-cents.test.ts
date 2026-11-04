import { describe, expect, it } from "vitest";
import type { AgingView, PaymentsView } from "../../../invoices/aging";
import { cents, type AgingBucket, type Cents } from "../../../rules-engine";
import type { LocalDate } from "../../../time/local-date";
import { centsIn, maskFigures, WITHHELD } from "../../operator/figures";
import { agingResult, getArAging } from "../tools/read/get-ar-aging";
import { paymentsResult } from "../tools/read/get-payments-in";

const day = (s: string) => s as LocalDate;
const buckets = (b: Record<AgingBucket, number>): Record<AgingBucket, Cents> =>
  Object.fromEntries(Object.entries(b).map(([k, v]) => [k, cents(v)])) as Record<AgingBucket, Cents>;

const aging: AgingView = {
  asOf: day("2026-11-04"),
  customers: [
    {
      customerId: "c1",
      code: "C1",
      name: "Acme Freight",
      buckets: buckets({ current: 100_000, "1_30": 25_050, "31_60": 0, "61_90": 7_500, over_90: 1_234_500 }),
      totalCents: 1_367_050,
    },
  ],
  totals: buckets({ current: 100_000, "1_30": 25_050, "31_60": 0, "61_90": 7_500, over_90: 1_234_500 }),
  totalCents: 1_367_050,
};

describe("get_ar_aging result", () => {
  it("names every bucket with Cents, in the totals and on each row", () => {
    const out = agingResult(aging);
    expect(out.totals).toEqual({
      currentCents: 100_000,
      days1To30Cents: 25_050,
      days31To60Cents: 0,
      days61To90Cents: 7_500,
      over90Cents: 1_234_500,
    });
    expect(out.rows[0]).toEqual({
      customerId: "c1",
      code: "C1",
      name: "Acme Freight",
      totalCents: 1_367_050,
      currentCents: 100_000,
      days1To30Cents: 25_050,
      days31To60Cents: 0,
      days61To90Cents: 7_500,
      over90Cents: 1_234_500,
    });
    expect(out.rows[0]).not.toHaveProperty("buckets");
  });

  it("says a past asOf is today's balances aged as of that date, not what was owed then", () => {
    expect(getArAging.description).toContain("it is not what was owed on that date");
  });

  it("lets an answer quote each bucket total", () => {
    const allowed = centsIn(agingResult(aging));
    const text = "Not yet due is $1,000.00. 1 to 30 days late is $250.50. Over 90 is $12,345.00.";
    expect(maskFigures(text, allowed)).toEqual({ text, masked: 0 });
    expect(maskFigures("Past due is $99.00.", allowed).text).toBe(`Past due is ${WITHHELD}.`);
  });
});

describe("get_payments_in result", () => {
  const view: PaymentsView = {
    from: day("2026-10-01"),
    to: day("2026-10-31"),
    payments: [],
    totalsByMethod: { check: 40_000, ach: 125_000, wire: 0 },
    totalCents: 165_000,
  };

  it("names each method's total with Cents, so an answer can quote it", () => {
    const out = paymentsResult(view);
    expect(out.totalsByMethod).toEqual({ checkCents: 40_000, achCents: 125_000, wireCents: 0 });
    const text = "By check $400.00, by ACH $1,250.00.";
    expect(maskFigures(text, centsIn(out))).toEqual({ text, masked: 0 });
  });
});
