import { describe, expect, it } from "vitest";
import { LOAD_NUMBERS_FIRST, LOAD_NUMBERS_NEXT, ReadLimitError } from "../data/read";
import type { Param, Queryable } from "../db";
import { loadCandidates } from "./candidates";
import { CONFIDENCE_FIELDS, type DocumentRead, type ReadFields } from "./types";

// A document's load is found from the paged read of load ids and numbers, by its whole normalized
// number, then read whole by its id. A fake query answers the tenant, the number pages (rows sorted
// by id, after the key, up to the LIMIT), the load by id and the reads that follow; any other
// statement fails the test. A by-id read that does not give back the one load fails closed.

const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CUSTOMER = idOf(900);

type Numbered = { id: string; load_number: string | null };
type Call = { sql: string; params: Param[] };

function fakeDb(loads: Numbered[], byId: (id: string) => Record<string, unknown>[] = (id) => fullLoads(loads, id)) {
  const sorted = [...loads].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const calls: Call[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      calls.push({ sql, params });
      if (sql === "SELECT id, slug, name, timezone FROM tenants WHERE id = current_tenant_id()") {
        return [{ id: idOf(800), slug: "test", name: "Test Carrier", timezone: "America/Chicago" }] as T[];
      }
      const page = / LIMIT (\d+)$/.exec(sql);
      const stem = page ? sql.slice(0, page.index) : null;
      if (page && (stem === LOAD_NUMBERS_FIRST || stem === LOAD_NUMBERS_NEXT)) {
        const after = stem === LOAD_NUMBERS_NEXT ? String(params[0]) : null;
        const rows = sorted.filter((r) => after === null || r.id > after).slice(0, Number(page[1]));
        return rows.map((r) => ({ ...r })) as T[];
      }
      const table = /^SELECT .+? FROM (\w+) WHERE tenant_id = current_tenant_id\(\)(?: AND (\w+) = CAST\(\$1 AS uuid\))? ORDER BY id$/s.exec(
        sql,
      );
      if (table?.[1] === "loads" && table[2] === "id") return byId(String(params[0])) as T[];
      if (table?.[1] === "customers" && table[2] === "id") {
        return (params[0] === CUSTOMER ? [{ id: CUSTOMER, name: "Test Shipper" }] : []) as T[];
      }
      if (table && ["drivers", "load_accessorials", "pay_items", "fuel_purchases"].includes(table[1])) return [];
      throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
    },
    async execute() {
      throw new Error("the candidates never write");
    },
  };
  return { q, calls };
}

// The load's whole row as the by-id read gives it (only the columns the candidates use).
function fullLoads(loads: Numbered[], id: string): Record<string, unknown>[] {
  return loads.filter((l) => l.id === id).map((l) => ({ ...l, customer_id: CUSTOMER, driver_id: null }));
}

const EMPTY: ReadFields = {
  sampleWord: true,
  vendor: null,
  date: null,
  totalCents: null,
  loadNumber: null,
  truckUnit: null,
  gallonsMilli: null,
  priceCents: null,
  loadedMiles: null,
  ratePerMileCents: null,
  linehaulCents: null,
  fuelSurchargeCents: null,
  customerName: null,
  stops: [],
};

function rateCon(loadNumber: string | null): DocumentRead {
  const confidence = Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])) as DocumentRead["confidence"];
  return { kind: "rate_confirmation", fields: { ...EMPTY, loadNumber }, textLines: [], confidence };
}

const numberPages = (calls: Call[]) =>
  calls.filter((c) => c.sql === `${LOAD_NUMBERS_FIRST} LIMIT 2` || c.sql === `${LOAD_NUMBERS_NEXT} LIMIT 2`);
const loadsById = (calls: Call[]) => calls.filter((c) => /FROM loads WHERE .* AND id = CAST\(\$1 AS uuid\)/s.test(c.sql));
const paging = { pageSize: 2, maxPages: 10 };

describe("loadCandidates", () => {
  const loads: Numbered[] = [
    { id: idOf(1), load_number: "BL-1041" },
    { id: idOf(2), load_number: "BL-10421" },
    { id: idOf(3), load_number: null },
    { id: idOf(4), load_number: " bl-1042 " },
    { id: idOf(5), load_number: "XBL-1042" },
    { id: idOf(6), load_number: "BL-1043" },
  ];

  it("finds the one load holding the whole number across pages, then reads that load by its id", async () => {
    const { q, calls } = fakeDb(loads);
    const c = await loadCandidates(q, rateCon("BL-1042"), paging);
    expect(c.loadMatches).toBe(1);
    expect(c.load).toMatchObject({ id: idOf(4), load_number: " bl-1042 ", customer_id: CUSTOMER });
    expect(c.customer).toMatchObject({ id: CUSTOMER });
    // Six loads in pages of two: three full pages, then the empty page that ends an exact multiple.
    expect(numberPages(calls).map((p) => p.params)).toEqual([[], [idOf(2)], [idOf(4)], [idOf(6)]]);
    expect(loadsById(calls).map((p) => p.params)).toEqual([[idOf(4)]]);
  });

  it("reports two matches and no load when two loads hold the number after normalizing", async () => {
    const { q, calls } = fakeDb([...loads, { id: idOf(7), load_number: "BL-1042" }]);
    const c = await loadCandidates(q, rateCon("bl-1042"), paging);
    expect(c.loadMatches).toBe(2);
    expect(c.load).toBeNull();
    expect(c.customer).toBeNull();
    expect(loadsById(calls)).toHaveLength(0);
  });

  it("reports no match for a number no load holds as a whole value", async () => {
    const { q, calls } = fakeDb(loads);
    const c = await loadCandidates(q, rateCon("BL-104"), paging);
    expect(c.loadMatches).toBe(0);
    expect(c.load).toBeNull();
    expect(loadsById(calls)).toHaveLength(0);
  });

  it("reads no loads at all when the reading has no load number", async () => {
    for (const number of [null, "   "]) {
      const { q, calls } = fakeDb(loads);
      const c = await loadCandidates(q, rateCon(number), paging);
      expect(c.loadMatches).toBe(0);
      expect(c.load).toBeNull();
      expect(calls.filter((s) => s.sql.includes("FROM loads"))).toHaveLength(0);
    }
  });

  it("fails closed when the by-id read does not give back the one load the number matched", async () => {
    const one = (over: Record<string, unknown>) => [{ ...fullLoads(loads, idOf(4))[0], ...over }];
    for (const byId of [
      () => [],
      (id: string) => [...fullLoads(loads, id), ...fullLoads(loads, id)],
      () => one({ load_number: "BL-1043" }),
    ]) {
      const { q } = fakeDb(loads, byId);
      await expect(loadCandidates(q, rateCon("BL-1042"), paging)).rejects.toThrow("the matched load is not one row");
    }
  });

  it("fails closed when the number read stops at its page bound", async () => {
    const { q, calls } = fakeDb(loads);
    await expect(loadCandidates(q, rateCon("BL-1042"), { pageSize: 2, maxPages: 2 })).rejects.toBeInstanceOf(
      ReadLimitError,
    );
    expect(loadsById(calls)).toHaveLength(0);
  });
});
