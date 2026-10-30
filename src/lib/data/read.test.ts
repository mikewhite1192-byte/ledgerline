import { describe, expect, it } from "vitest";
import type { Param, Queryable } from "../db";
import {
  LOAD_NUMBER_PAGING,
  LOAD_NUMBERS_FIRST,
  LOAD_NUMBERS_NEXT,
  ReadLimitError,
  PAID_BETWEEN,
  PURCHASED_BETWEEN,
  readDeliveredBetween,
  readIftaInput,
  readLoadNumbers,
  readPaidBetween,
  type LoadNumberRow,
} from "./read";

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

// The IFTA quarter reader: the same pages over the quarter's loads, their state miles and the fuel
// bought in it, every statement in the tenant and carrying the quarter's two dates.
const Q4 = { start: "2026-10-01", end: "2026-12-31" };

describe("readIftaInput in pages", () => {
  it("pages the three tables, each statement in the tenant, the fuel by its purchase date", async () => {
    const { q, calls } = fakeDb({ loads: loads(3), load_state_miles: loads(5), fuel_purchases: loads(4) });
    const out = await readIftaInput(q, Q4, { pageSize: 2, maxPages: 4 });
    expect(out.loads.map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
    expect(out.load_state_miles.map((r) => r.id)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    expect(out.fuel_purchases.map((r) => r.id)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(Object.keys(out).sort()).toEqual(["fuel_purchases", "load_state_miles", "loads"]);
    expect(new Set(calls.map((c) => c.table))).toEqual(new Set(["loads", "load_state_miles", "fuel_purchases"]));
    for (const c of calls) {
      expect(c.sql).toContain("tenant_id = current_tenant_id()");
      expect(c.sql).toMatch(/ ORDER BY id LIMIT 2$/);
      expect(c.params.slice(0, 2)).toEqual([Q4.start, Q4.end]);
    }
    for (const c of of(calls, "fuel_purchases")) {
      expect(c.sql).toContain(PURCHASED_BETWEEN);
      expect(c.sql).not.toContain("delivered_on");
    }
    for (const c of [...of(calls, "loads"), ...of(calls, "load_state_miles")]) {
      expect(c.sql).toContain("delivered_on BETWEEN CAST($1 AS date) AND CAST($2 AS date)");
    }
    // Four fuel rows at two a page: two full pages and one empty one.
    expect(of(calls, "fuel_purchases").map((c) => c.params.at(-1))).toEqual([Q4.end, id(2), id(4)]);
  });

  it("throws at the page bound instead of returning part of the quarter's fuel", async () => {
    const { q } = fakeDb({ loads: loads(1), fuel_purchases: loads(5) });
    const read = readIftaInput(q, Q4, { pageSize: 2, maxPages: 2 });
    await expect(read).rejects.toBeInstanceOf(ReadLimitError);
    await expect(read).rejects.toMatchObject({ category: "too_many_rows" });
  });

  it("refuses a quarter that is not two dates in order before reading anything", async () => {
    const { q, calls } = fakeDb({});
    await expect(readIftaInput(q, { start: "2026-12-31", end: "2026-10-01" })).rejects.toBeInstanceOf(RangeError);
    await expect(readIftaInput(q, { start: "2026-10-01", end: "2026-13-01" })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });
});

// The year-end 1099's window: a day either side of 2026 in UTC.
const YEAR = { start: "2025-12-31T00:00:00.000Z", end: "2027-01-02T00:00:00.000Z" };

describe("readPaidBetween in pages", () => {
  it("pages the three tables, each statement in the tenant, every one through the paid window", async () => {
    const { q, calls } = fakeDb({ settlements: loads(3), settlement_lines: loads(5), drivers: loads(2) });
    const out = await readPaidBetween(q, YEAR, { pageSize: 2, maxPages: 4 });
    expect(out.settlements.map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
    expect(out.settlement_lines.map((r) => r.id)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    expect(out.drivers.map((r) => r.id)).toEqual([id(1), id(2)]);
    expect(Object.keys(out).sort()).toEqual(["drivers", "settlement_lines", "settlements"]);
    expect(new Set(calls.map((c) => c.table))).toEqual(new Set(["settlements", "settlement_lines", "drivers"]));
    for (const c of calls) {
      expect(c.sql).toContain("tenant_id = current_tenant_id()");
      expect(c.sql).toContain(PAID_BETWEEN);
      expect(c.sql).toMatch(/ ORDER BY id LIMIT 2$/);
      expect(c.params.slice(0, 2)).toEqual([YEAR.start, YEAR.end]);
    }
    for (const c of of(calls, "settlement_lines")) {
      expect(c.sql).toContain("kind IN ('load_pay', 'accessorial_pay', 'reimbursement')");
    }
    // Two drivers at two a page: one full page and one empty one.
    expect(of(calls, "drivers").map((c) => c.params.at(-1))).toEqual([YEAR.end, id(2)]);
  });

  it("sends the window as UTC instants whatever offset it was written with", async () => {
    const { q, calls } = fakeDb({});
    await readPaidBetween(q, { start: "2025-12-31T19:00:00-05:00", end: "2027-01-01T19:00:00-05:00" });
    for (const c of calls) expect(c.params).toEqual(["2026-01-01T00:00:00.000Z", "2027-01-02T00:00:00.000Z"]);
  });

  it("throws at the page bound instead of returning part of the year's settlements", async () => {
    const { q } = fakeDb({ settlements: loads(5) });
    const read = readPaidBetween(q, YEAR, { pageSize: 2, maxPages: 2 });
    await expect(read).rejects.toBeInstanceOf(ReadLimitError);
    await expect(read).rejects.toMatchObject({ category: "too_many_rows" });
  });

  it("throws at the page bound on the lines too, never a short total", async () => {
    const { q } = fakeDb({ settlements: loads(1), settlement_lines: loads(5) });
    const read = readPaidBetween(q, YEAR, { pageSize: 2, maxPages: 2 });
    await expect(read).rejects.toBeInstanceOf(ReadLimitError);
  });

  it("refuses a window that is not two instants in order before reading anything", async () => {
    const { q, calls } = fakeDb({});
    await expect(readPaidBetween(q, { start: YEAR.end, end: YEAR.start })).rejects.toBeInstanceOf(RangeError);
    await expect(readPaidBetween(q, { start: YEAR.start, end: YEAR.start })).rejects.toBeInstanceOf(RangeError);
    await expect(readPaidBetween(q, { start: "2026-01-01", end: YEAR.end })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });
});

// The load number reader, against a fake that serves its pages from rows sorted by id: after the
// key parameter when the statement has one, up to its LIMIT. Every load is seen once, and a read
// that reaches its bound fails closed.

function fakeLoadNumbers(rows: LoadNumberRow[]): { q: Queryable; calls: { sql: string; params: Param[] }[] } {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const calls: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      calls.push({ sql, params });
      const limit = Number(/ LIMIT (\d+)$/.exec(sql)?.[1]);
      const after = params.length === 1 ? String(params[0]) : null;
      return sorted.filter((r) => after === null || r.id > after).slice(0, limit).map((r) => ({ ...r })) as T[];
    },
    async execute() {
      throw new Error("the reader never writes");
    },
  };
  return { q, calls };
}

const numbered = (ids: number[]) => ids.map((i) => ({ id: id(i), load_number: `L-${i}` }));

describe("readLoadNumbers in pages", () => {
  it("returns every load once, in key order, as its id and load number", async () => {
    const { q, calls } = fakeLoadNumbers([...numbered([5, 3, 1]), { id: id(4), load_number: null }, ...numbered([2])]);
    const out = await readLoadNumbers(q, { pageSize: 2, maxPages: 10 });
    expect(out).toEqual([...numbered([1, 2, 3]), { id: id(4), load_number: null }, ...numbered([5])]);
    // Three pages: the first without a key, then after the last id of each full page.
    expect(calls.map((c) => c.params)).toEqual([[], [id(2)], [id(4)]]);
  });

  it("orders by the uuid id and keys each next page on it, never on the text alias", async () => {
    const { q, calls } = fakeLoadNumbers(numbered([1, 2, 3]));
    await readLoadNumbers(q, { pageSize: 2, maxPages: 10 });
    expect(calls.map((c) => c.sql)).toEqual([`${LOAD_NUMBERS_FIRST} LIMIT 2`, `${LOAD_NUMBERS_NEXT} LIMIT 2`]);
    expect(LOAD_NUMBERS_FIRST).toMatch(/ ORDER BY loads\.id$/);
    expect(LOAD_NUMBERS_FIRST).not.toContain("$1");
    expect(LOAD_NUMBERS_NEXT).toMatch(/ AND loads\.id > CAST\(\$1 AS uuid\) ORDER BY loads\.id$/);
    for (const sql of [LOAD_NUMBERS_FIRST, LOAD_NUMBERS_NEXT]) {
      expect(sql.startsWith("SELECT CAST(id AS text) AS id, load_number FROM loads WHERE tenant_id = current_tenant_id()")).toBe(
        true,
      );
    }
  });

  it("ends cleanly on an exact multiple of the page size, with one empty page", async () => {
    const { q, calls } = fakeLoadNumbers(numbered([1, 2, 3, 4]));
    expect((await readLoadNumbers(q, { pageSize: 2, maxPages: 3 })).map((r) => r.id)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(calls.map((c) => c.params)).toEqual([[], [id(2)], [id(4)]]);
    // No loads at all is one empty page.
    const none = fakeLoadNumbers([]);
    expect(await readLoadNumbers(none.q, { pageSize: 2, maxPages: 1 })).toEqual([]);
    expect(none.calls).toHaveLength(1);
  });

  it("throws at the page bound instead of returning part of the loads", async () => {
    const { q, calls } = fakeLoadNumbers(numbered([1, 2, 3, 4, 5]));
    const read = readLoadNumbers(q, { pageSize: 2, maxPages: 2 });
    await expect(read).rejects.toBeInstanceOf(ReadLimitError);
    await expect(read).rejects.toMatchObject({ category: "too_many_rows" });
    // Two pages were read and the read stopped there.
    expect(calls).toHaveLength(2);
  });

  it("fails closed on a page larger than asked or a key that is not a uuid", async () => {
    const big: Queryable = {
      query: async <T>() => numbered([1, 2, 3]) as T[],
      execute: async () => 0,
    };
    await expect(readLoadNumbers(big, { pageSize: 2, maxPages: 5 })).rejects.toThrow("a page is larger than its page size");
    const badKey = fakeLoadNumbers([
      { id: "load-a", load_number: "L-1" },
      { id: "load-b", load_number: "L-2" },
    ]);
    await expect(readLoadNumbers(badKey.q, { pageSize: 2, maxPages: 5 })).rejects.toThrow("a page key is not a uuid");
    expect(badKey.calls).toHaveLength(1);
  });

  it("refuses a page size or bound that is not a positive count", async () => {
    const { q, calls } = fakeLoadNumbers(numbered([1]));
    for (const paging of [
      { pageSize: 0, maxPages: 1 },
      { pageSize: 2, maxPages: 0 },
      { pageSize: 1.5, maxPages: 1 },
      { pageSize: 2, maxPages: 1.5 },
    ]) {
      await expect(readLoadNumbers(q, paging)).rejects.toBeInstanceOf(RangeError);
    }
    expect(calls).toHaveLength(0);
  });

  it("keeps a page of ids and load numbers far under the 1 MiB answer cap", () => {
    // About 150 bytes of Data API JSON a row, generously: 1,000 rows is about 150 KB.
    expect(LOAD_NUMBER_PAGING.pageSize * 150).toBeLessThan(1024 * 1024 / 4);
    expect(LOAD_NUMBER_PAGING.pageSize * LOAD_NUMBER_PAGING.maxPages).toBe(200_000);
  });
});
