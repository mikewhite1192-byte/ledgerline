import { describe, expect, it } from "vitest";
import { ReadLimitError } from "../data/read";
import type { Param, Queryable } from "../db";
import { countLoadsWithNumber } from "./candidates";

// The loads count reads through the paged load number reader (data/read.ts readLoadNumbers, whose
// own tests hold the cursor, the exact multiple, the bad key and the page size), so no statement's
// answer nears the Data API's 1 MiB cap. A fake query serves the pages from rows sorted by id:
// every load is seen once, the compare is the whole normalized value, and a read that reaches its
// bound fails closed.

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
    const { q, calls } = fakeLoads([
      { id: idOf(1), load_number: "RC-7001" },
      { id: idOf(2), load_number: "RC-70011" },
      { id: idOf(3), load_number: null },
      { id: idOf(4), load_number: " rc-7001 " },
      { id: idOf(5), load_number: "XRC-7001" },
      { id: idOf(6), load_number: "RC-7001" },
      { id: idOf(7), load_number: "RC-7002" },
    ]);
    expect(await countLoadsWithNumber(q, "RC-7001", idOf(99), paging)).toBe(3);
    // Seven loads in pages of two: three full pages and a short one.
    expect(calls).toHaveLength(4);
  });

  it("never counts the card's own load", async () => {
    const { q } = fakeLoads([
      { id: idOf(1), load_number: "RC-7001" },
      { id: idOf(2), load_number: "RC-7001" },
      { id: idOf(3), load_number: "RC-7001" },
    ]);
    expect(await countLoadsWithNumber(q, "RC-7001", idOf(3), paging)).toBe(2);
  });

  it("fails closed at its page bound, never a partial count", async () => {
    const { q } = fakeLoads([1, 2, 3, 4, 5].map((n) => ({ id: idOf(n), load_number: "RC-7001" })));
    await expect(countLoadsWithNumber(q, "RC-7001", idOf(99), { pageSize: 2, maxPages: 2 })).rejects.toBeInstanceOf(
      ReadLimitError,
    );
  });
});
