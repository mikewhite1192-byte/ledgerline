import { describe, expect, it } from "vitest";
import type { Param, Queryable } from "../db";
import { ReadLimitError, readDeliveredBetween } from "./read";

// The month reader in pages, against a fake that answers each statement the way the database
// would: the named table's rows in id order, after the key parameter when the statement has one,
// up to its LIMIT. A small page size stands in for a large month.

const OCTOBER = { start: "2026-10-01", end: "2026-10-31" };
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

type Call = { table: string; sql: string; params: Param[] };

function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  const calls: Call[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []) {
      const table = /FROM (\w+) WHERE/.exec(sql)?.[1] ?? "";
      calls.push({ table, sql, params });
      const limit = Number(/ LIMIT (\d+)$/.exec(sql)?.[1]);
      const after = sql.includes("id > CAST($3 AS uuid)") ? String(params[2]) : null;
      const rows = [...(tables[table] ?? [])]
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
        .filter((r) => after === null || String(r.id) > after)
        .slice(0, limit);
      return rows.map((r) => ({ ...r })) as T[];
    },
    async execute() {
      throw new Error("the reader never writes");
    },
  };
  return { q, calls };
}

// Rows out of key order, so the order that comes back is the reader's, not the fixture's.
const loads = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: id(n - i), load_number: `L-${n - i}` }));
const of = (calls: Call[], table: string) => calls.filter((c) => c.table === table);

describe("readDeliveredBetween in pages", () => {
  it("returns every row of a month longer than one page, once, in key order", async () => {
    const { q, calls } = fakeDb({ loads: loads(5), load_state_miles: loads(3) });
    const out = await readDeliveredBetween(q, OCTOBER, { pageSize: 2, maxPages: 3 });
    expect(out.loads.map((r) => r.id)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    expect(out.load_state_miles.map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
    // Three pages of loads: the first without a key, then after the last id of each full page.
    const pages = of(calls, "loads");
    expect(pages.map((c) => c.params)).toEqual([
      [OCTOBER.start, OCTOBER.end],
      [OCTOBER.start, OCTOBER.end, id(2)],
      [OCTOBER.start, OCTOBER.end, id(4)],
    ]);
    for (const c of calls) {
      expect(c.sql).toContain("delivered_on BETWEEN CAST($1 AS date) AND CAST($2 AS date)");
      expect(c.sql).toMatch(/ ORDER BY id LIMIT 2$/);
    }
    // Tables with fewer rows than a page take one statement each.
    for (const table of ["customers", "load_accessorials", "invoices"]) {
      expect(of(calls, table)).toHaveLength(1);
    }
  });

  it("ends cleanly on an exact multiple of the page size, with one empty page", async () => {
    const { q, calls } = fakeDb({ loads: loads(4), invoices: [] });
    const out = await readDeliveredBetween(q, OCTOBER, { pageSize: 2, maxPages: 3 });
    expect(out.loads.map((r) => r.id)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(out.invoices).toEqual([]);
    expect(of(calls, "loads").map((c) => c.params.at(-1))).toEqual([OCTOBER.end, id(2), id(4)]);
    expect(of(calls, "invoices")).toHaveLength(1);
  });

  it("throws at the page bound instead of returning part of the month", async () => {
    const { q, calls } = fakeDb({ loads: loads(5) });
    const read = readDeliveredBetween(q, OCTOBER, { pageSize: 2, maxPages: 2 });
    await expect(read).rejects.toBeInstanceOf(ReadLimitError);
    await expect(read).rejects.toMatchObject({ category: "too_many_rows" });
    // Two pages were read and the read stopped there; nothing after the bound was asked for.
    expect(of(calls, "loads")).toHaveLength(2);
    expect(of(calls, "customers")).toHaveLength(0);
  });

  it("fails closed on a page larger than asked or a key that is not a uuid", async () => {
    const big: Queryable = {
      query: async <T>() => loads(3) as T[],
      execute: async () => 0,
    };
    await expect(readDeliveredBetween(big, OCTOBER, { pageSize: 2, maxPages: 5 })).rejects.toThrow(
      "a page is larger than its page size",
    );
    const badKey: Queryable = {
      query: async <T>() => [{ id: "L-1" }, { id: "L-2" }] as T[],
      execute: async () => 0,
    };
    await expect(readDeliveredBetween(badKey, OCTOBER, { pageSize: 2, maxPages: 5 })).rejects.toThrow(
      "a page key is not a uuid",
    );
  });

  it("refuses a page size or bound that is not a positive count", async () => {
    const { q, calls } = fakeDb({});
    for (const paging of [
      { pageSize: 0, maxPages: 1 },
      { pageSize: 2, maxPages: 0 },
      { pageSize: 1.5, maxPages: 1 },
    ]) {
      await expect(readDeliveredBetween(q, OCTOBER, paging)).rejects.toBeInstanceOf(RangeError);
    }
    expect(calls).toHaveLength(0);
  });
});
