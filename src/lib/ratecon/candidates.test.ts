import { describe, expect, it } from "vitest";
import { ReadLimitError } from "../data/read";
import type { Param, Queryable } from "../db";
import { countLoadsWithNumber, LOAD_PAGING } from "./candidates";

// The loads count reads in pages keyed on the uuid id, so no statement's answer nears the Data
// API's 1 MiB cap. A fake query serves the pages from rows sorted by id: every load is seen once,
// the compare is the whole normalized value, and a read that reaches its bound fails closed.

const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Row = { id: string; load_number: string | null };

function fakeLoads(rows: Row[]): { q: Queryable; calls: { sql: string; params: Param[] }[] } {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const calls: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      calls.push({ sql, params });
      const limit = Number(/LIMIT (\d+)$/.exec(sql)?.[1]);
      const after = params.length === 1 ? String(params[0]) : null;
      return sorted.filter((r) => after === null || r.id > after).slice(0, limit) as T[];
    },
    async execute() {
      throw new Error("the count never writes");
    },
  };
  return { q, calls };
}

const paging = { pageSize: 2, maxPages: 10 };

describe("countLoadsWithNumber", () => {
  it("counts every load holding the number across pages, as a whole normalized value", async () => {
    const { q } = fakeLoads([
      { id: idOf(1), load_number: "RC-7001" },
      { id: idOf(2), load_number: "RC-70011" },
      { id: idOf(3), load_number: null },
      { id: idOf(4), load_number: " rc-7001 " },
      { id: idOf(5), load_number: "XRC-7001" },
      { id: idOf(6), load_number: "RC-7001" },
      { id: idOf(7), load_number: "RC-7002" },
    ]);
    expect(await countLoadsWithNumber(q, "RC-7001", idOf(99), paging)).toBe(3);
  });

  it("never counts the card's own load", async () => {
    const { q } = fakeLoads([
      { id: idOf(1), load_number: "RC-7001" },
      { id: idOf(2), load_number: "RC-7001" },
      { id: idOf(3), load_number: "RC-7001" },
    ]);
    expect(await countLoadsWithNumber(q, "RC-7001", idOf(3), paging)).toBe(2);
  });

  it("orders by the uuid id, passes the last id of a page as the next cursor, and stops on a short page", async () => {
    const { q, calls } = fakeLoads([1, 2, 3, 4].map((n) => ({ id: idOf(n), load_number: "RC-1" })));
    expect(await countLoadsWithNumber(q, "RC-7001", idOf(99), paging)).toBe(0);
    // Two full pages, then the empty page that ends an exact multiple.
    expect(calls.map((c) => c.params)).toEqual([[], [idOf(2)], [idOf(4)]]);
    for (const c of calls) expect(c.sql).toMatch(/ORDER BY loads\.id LIMIT 2$/);
    expect(calls[0].sql).not.toContain("$1");
    expect(calls[1].sql).toContain("AND id > CAST($1 AS uuid)");
  });

  it("fails closed at its page bound, never a partial count", async () => {
    const { q } = fakeLoads([1, 2, 3, 4, 5].map((n) => ({ id: idOf(n), load_number: "RC-7001" })));
    await expect(countLoadsWithNumber(q, "RC-7001", idOf(99), { pageSize: 2, maxPages: 2 })).rejects.toBeInstanceOf(
      ReadLimitError,
    );
  });

  it("refuses a page key that is not a uuid and paging that is not a positive count", async () => {
    const { q } = fakeLoads([
      { id: "load-a", load_number: "RC-7001" },
      { id: "load-b", load_number: "RC-7001" },
    ]);
    await expect(countLoadsWithNumber(q, "RC-7001", idOf(99), paging)).rejects.toThrow("a page key is not a uuid");
    for (const bad of [{ pageSize: 0, maxPages: 1 }, { pageSize: 2, maxPages: 1.5 }]) {
      await expect(countLoadsWithNumber(q, "RC-7001", idOf(99), bad)).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("keeps a page of ids and load numbers far under the 1 MiB answer cap", () => {
    // About 150 bytes of Data API JSON a row, generously: 1,000 rows is about 150 KB.
    expect(LOAD_PAGING.pageSize * 150).toBeLessThan(1024 * 1024 / 4);
    expect(LOAD_PAGING.pageSize * LOAD_PAGING.maxPages).toBe(200_000);
  });
});
