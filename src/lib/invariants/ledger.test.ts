import { describe, expect, it } from "vitest";
import { DbError, type Db, type Queryable } from "../db/types";
import { checkLedger, judgeLedger, type LedgerRows } from "./ledger";

// A clean week: 1,000.00 earned, 250.00 deducted, 750.00 net; plus a short week carried forward.
function clean(): LedgerRows {
  return {
    settlements: [
      { gross: 100000, deductions: 25000, net: 75000, carry: 0, earned: 100000, deducted: -25000, odd_lines: 0, lines: 4 },
      // Deductions above gross: net floors at zero and the shortfall carries forward.
      { gross: "20000", deductions: "30000", net: "0", carry: "10000", earned: "20000", deducted: "-30000", odd_lines: 0, lines: 3 },
    ],
    recoveries: [
      { recovered: 5000, recovered_lines: 5000 },
      { recovered: 0, recovered_lines: 0 },
    ],
    recoveryLines: [{ lines: 1, uncited: 0, orphaned: 0 }],
    payouts: [{ amount: 75000, outside_amount: 75000, subject_amount: 75000, same_driver: true }],
    payments: [
      { amount: 50000, applied: 50000 },
      { amount: 50000, applied: 0 },
    ],
    invoices: [
      { status: "paid", amount: 50000, has_paid_on: true, applied: 50000 },
      { status: "partially_paid", amount: 50000, has_paid_on: false, applied: 100 },
      { status: "open", amount: 50000, has_paid_on: false, applied: 0 },
      { status: "void", amount: 50000, has_paid_on: false, applied: 0 },
    ],
  };
}

describe("judgeLedger", () => {
  it("passes a ledger that balances, with counts of what it read", () => {
    const r = judgeLedger(clean());
    expect(r.verdict).toBe("PASS");
    expect(r.counts).toEqual({ settlements: 2, lines: 7, advances: 2, payouts: 1, payments: 2, invoices: 3 });
  });

  it("catches a settlement whose totals are off by one cent", () => {
    for (const change of [{ net: 75001 }, { gross: 100001 }, { deductions: 24999 }, { carry: 1 }, { deducted: -25001 }]) {
      const rows = clean();
      rows.settlements[0] = { ...rows.settlements[0], ...change };
      expect(judgeLedger(rows).violations).toEqual({ settlement_totals_off: 1 });
    }
  });

  it("catches a line of a kind it does not know", () => {
    const rows = clean();
    rows.settlements[0].odd_lines = 1;
    expect(judgeLedger(rows).violations).toEqual({ settlement_line_kind_unknown: 1 });
  });

  it("catches recoveries that do not tie out to the advance", () => {
    const rows = clean();
    rows.recoveries[0].recovered = 5001;
    rows.recoveryLines[0] = { lines: 3, uncited: 1, orphaned: 1 };
    expect(judgeLedger(rows).violations).toEqual({ recovery_off: 1, recovery_line_uncited: 1, recovery_line_orphaned: 1 });
  });

  it("catches a payout that paid the wrong amount or the wrong driver, or has no subject", () => {
    for (const change of [{ amount: 75001 }, { outside_amount: 75001 }, { outside_amount: null }, { same_driver: false }]) {
      const rows = clean();
      rows.payouts[0] = { ...rows.payouts[0], ...change };
      expect(judgeLedger(rows).violations).toEqual({ payout_mismatch: 1 });
    }
    const rows = clean();
    rows.payouts[0].subject_amount = null;
    expect(judgeLedger(rows).violations).toEqual({ payout_subject_missing: 1 });
  });

  it("catches a payment applied for more than it brought in", () => {
    const rows = clean();
    rows.payments[1].applied = 50001;
    expect(judgeLedger(rows).violations).toEqual({ payment_overapplied: 1 });
  });

  it("catches an invoice whose status is not the one its applications give it", () => {
    for (const change of [
      { status: "open" },
      { has_paid_on: false },
      { applied: 49999 },
      { status: "bogus" },
    ]) {
      const rows = clean();
      rows.invoices[0] = { ...rows.invoices[0], ...change };
      expect(judgeLedger(rows).violations).toEqual({ invoice_status_off: 1 });
    }
    const rows = clean();
    rows.invoices[2].has_paid_on = true;
    expect(judgeLedger(rows).violations).toEqual({ invoice_status_off: 1 });
  });

  it("counts an over-applied invoice as paid, as the receivables rules do", () => {
    const rows = clean();
    rows.invoices[0].applied = 60000;
    expect(judgeLedger(rows).verdict).toBe("PASS");
  });

  it("treats a value that is not a whole number as unread, never as zero", () => {
    const rows = clean();
    rows.settlements[0].net = "750.00";
    expect(() => judgeLedger(rows)).toThrow("not_whole");
    const missing = clean();
    missing.recoveryLines = [];
    expect(() => judgeLedger(missing)).toThrow("recovery_lines_unread");
  });
});

describe("checkLedger", () => {
  const db = (fail: unknown): Db => ({
    withTenant: async () => {
      throw new Error("not used");
    },
    withoutTenant: async <T>(fn: (q: Queryable) => Promise<T>) => {
      const q: Queryable = {
        query: async () => {
          throw fail;
        },
        execute: async () => 0,
      };
      return fn(q);
    },
    close: async () => {},
  });

  it("is UNKNOWN, with the category only, when a read fails", async () => {
    const r = await checkLedger(db(new DbError("timeout", "57014")));
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.unknown).toEqual(["read_failed_timeout_57014"]);
  });
});
