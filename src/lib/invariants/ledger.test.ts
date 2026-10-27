import { describe, expect, it } from "vitest";
import { DbError, type Db, type Param, type Queryable } from "../db/types";
import { INVOICES_AFTER_SQL, INVOICES_FIRST_SQL, checkLedger, judgeLedger, type InvoiceRow, type LedgerRows } from "./ledger";
import { MAX_PAGES, PAGE_SIZE } from "./types";

const TENANT = "00000000-0000-4000-8000-000000000001";
const key = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const invoice = (n: number, over: Partial<InvoiceRow> = {}): InvoiceRow => ({
  page_tenant: TENANT,
  page_id: key(n),
  status: "open",
  amount: 50000,
  has_paid_on: false,
  applied: 0,
  ...over,
});

// A clean ledger, as the aggregates read it: two settlements with seven lines, two advances, one
// confirmed payout, two customer payments, and four invoices read one row each.
function clean(): LedgerRows {
  return {
    settlements: [{ settlements: 2, lines: "7", unread: 0, odd_kind: 0, totals_off: 0 }],
    recoveries: [{ advances: 2, unread: 0, recovery_off: 0 }],
    recoveryLines: [{ lines: 1, uncited: 0, orphaned: 0 }],
    payouts: [{ payouts: 1, subject_missing: 0, unread: 0, mismatch: 0 }],
    payments: [{ payments: "2", unread: "0", overapplied: "0" }],
    invoices: [
      invoice(1, { status: "paid", has_paid_on: true, applied: 50000 }),
      invoice(2, { status: "partially_paid", applied: 100 }),
      invoice(3),
      invoice(4, { status: "void" }),
    ],
  };
}

describe("judgeLedger", () => {
  it("passes a ledger that balances, with counts of what it read", () => {
    const r = judgeLedger(clean());
    expect(r.verdict).toBe("PASS");
    expect(r.counts).toEqual({ settlements: 2, lines: 7, advances: 2, payouts: 1, payments: 2, invoices: 3 });
  });

  it("reports each aggregate's count under its category", () => {
    const cases: [(rows: LedgerRows) => void, Record<string, number>][] = [
      [(r) => (r.settlements[0].totals_off = 2), { settlement_totals_off: 2 }],
      [(r) => (r.settlements[0].odd_kind = 1), { settlement_line_kind_unknown: 1 }],
      [(r) => (r.recoveries[0].recovery_off = "3"), { recovery_off: 3 }],
      [(r) => (r.recoveryLines[0] = { lines: 3, uncited: 1, orphaned: 1 }), { recovery_line_uncited: 1, recovery_line_orphaned: 1 }],
      [(r) => (r.payouts[0].mismatch = 1), { payout_mismatch: 1 }],
      [(r) => (r.payouts[0].subject_missing = 1), { payout_subject_missing: 1 }],
      [(r) => (r.payments[0].overapplied = 1), { payment_overapplied: 1 }],
    ];
    for (const [change, expected] of cases) {
      const rows = clean();
      change(rows);
      const r = judgeLedger(rows);
      expect(r.verdict).toBe("FAIL");
      expect(r.violations).toEqual(expected);
    }
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

  it("treats a count that is not a whole number, or a record the read refused, as unread, never as zero", () => {
    const bad: [(rows: LedgerRows) => void, string][] = [
      [(r) => (r.settlements[0].totals_off = "1.5"), "not_whole"],
      [(r) => (r.settlements[0].lines = null), "not_whole"],
      [(r) => (r.payouts[0].mismatch = -1), "not_whole"],
      [(r) => (r.payments[0].payments = true), "not_whole"],
      [(r) => (r.settlements[0].unread = 1), "not_whole"],
      [(r) => (r.recoveries[0].unread = 1), "not_whole"],
      [(r) => (r.payouts[0].unread = 1), "not_whole"],
      [(r) => (r.payments[0].unread = 1), "not_whole"],
      [(r) => (r.invoices[1].amount = "500.00"), "not_whole"],
      [(r) => (r.settlements = []), "settlements_unread"],
      [(r) => r.recoveries.push(r.recoveries[0]), "recoveries_unread"],
      [(r) => (r.recoveryLines = []), "recovery_lines_unread"],
      [(r) => (r.payouts = []), "payouts_unread"],
      [(r) => (r.payments = []), "payments_unread"],
    ];
    for (const [change, category] of bad) {
      const rows = clean();
      change(rows);
      expect(() => judgeLedger(rows)).toThrow(category);
    }
  });
});

// A database whose aggregates read clean and whose invoices come back `total` rows, in pages as
// the paged statements ask (the page size is the last parameter, the last key the one before).
function fakeDb(total: number, over: { settlements?: Record<string, unknown> } = {}) {
  const calls: { sql: string; params?: Param[] }[] = [];
  const base = clean();
  const q: Queryable = {
    query: async <T>(sql: string, params?: Param[]) => {
      calls.push({ sql, params });
      if (sql === INVOICES_FIRST_SQL || sql === INVOICES_AFTER_SQL) {
        const size = Number(params?.[params.length - 1]);
        const start = sql === INVOICES_FIRST_SQL ? 1 : Number(String(params?.[1]).slice(-12)) + 1;
        const rows: InvoiceRow[] = [];
        for (let n = start; n < start + size && n <= total; n += 1) rows.push(invoice(n));
        return rows as T[];
      }
      if (sql.includes("AS totals_off")) return [{ ...base.settlements[0], ...over.settlements }] as T[];
      if (sql.includes("AS recovery_off")) return base.recoveries as T[];
      if (sql.includes("AS orphaned")) return base.recoveryLines as T[];
      if (sql.includes("AS subject_missing")) return base.payouts as T[];
      if (sql.includes("AS overapplied")) return base.payments as T[];
      throw new Error("unexpected statement");
    },
    execute: async () => 0,
  };
  const db: Db = {
    withTenant: async () => {
      throw new Error("not used");
    },
    withoutTenant: async <T>(fn: (q: Queryable) => Promise<T>) => fn(q),
    close: async () => {},
  };
  return { db, calls };
}

const paged = (sql: string) => sql === INVOICES_FIRST_SQL || sql === INVOICES_AFTER_SQL;

describe("checkLedger", () => {
  const failing = (fail: unknown): Db => ({
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
    const r = await checkLedger(failing(new DbError("timeout", "57014")));
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.unknown).toEqual(["read_failed_timeout_57014"]);
  });

  it("reads one row per aggregate and every invoice, a page at a time after the last key", async () => {
    const total = PAGE_SIZE * 2 + 7;
    const { db, calls } = fakeDb(total);
    const r = await checkLedger(db);
    expect(r.verdict).toBe("PASS");
    expect(r.counts.invoices).toBe(total);
    expect(calls.filter((c) => paged(c.sql)).map((c) => c.params)).toEqual([
      [PAGE_SIZE],
      [TENANT, key(PAGE_SIZE), PAGE_SIZE],
      [TENANT, key(PAGE_SIZE * 2), PAGE_SIZE],
    ]);
    // Every other statement is an aggregate, read once.
    expect(calls.filter((c) => !paged(c.sql))).toHaveLength(5);
  });

  it("stops at an empty page after a full one", async () => {
    const { db, calls } = fakeDb(PAGE_SIZE);
    const r = await checkLedger(db);
    expect(r.counts.invoices).toBe(PAGE_SIZE);
    expect(calls.filter((c) => c.sql === INVOICES_AFTER_SQL)).toHaveLength(1);
  });

  it("is UNKNOWN, never a partial verdict, when the invoices run past the page cap", async () => {
    const { db, calls } = fakeDb(PAGE_SIZE * MAX_PAGES + 1);
    const r = await checkLedger(db);
    expect({ verdict: r.verdict, unknown: r.unknown, counts: r.counts }).toEqual({
      verdict: "UNKNOWN",
      unknown: ["page_cap"],
      counts: {},
    });
    expect(calls.filter((c) => paged(c.sql))).toHaveLength(MAX_PAGES);
  });

  it("is UNKNOWN when an aggregate's count is not a whole number", async () => {
    const { db } = fakeDb(3, { settlements: { totals_off: "0.5" } });
    const r = await checkLedger(db);
    expect({ verdict: r.verdict, unknown: r.unknown }).toEqual({ verdict: "UNKNOWN", unknown: ["not_whole"] });
  });
});
