import { describe, expect, it } from "vitest";
import type { Param, Queryable } from "../db";
import { assertIdentifier, TENANT_TABLES } from "./tables";
import {
  deleteTenantRows,
  insertRows,
  insertStatements,
  MAX_PARAMS_PER_INSERT,
  MAX_STATEMENT_CHARS,
} from "./writer";

const customer = (i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  code: `C${i}`,
  name: `Invented Customer ${i}`,
  terms_days: 30,
  city: "Springfield",
  state: "MO",
  detention_free_minutes: 120,
  detention_hourly_cents: 5000,
});

const line = (meta: Record<string, number> | null, label = "Load X-1") => ({
  id: "00000000-0000-4000-8000-000000000001",
  settlement_id: "00000000-0000-4000-8000-000000000002",
  seq: 1,
  kind: "load_pay",
  label,
  amount_cents: 82500,
  sources: [{ table: "loads", id: "00000000-0000-4000-8000-000000000003" }],
  meta,
});

// A fake connection that records each statement and reports `affected(rows)` rows.
function fakeQ(affected: (sql: string, params: Param[]) => number) {
  const seen: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query() {
      throw new Error("not used");
    },
    async execute(sql, params = []) {
      seen.push({ sql, params });
      return affected(sql, params);
    },
  };
  return { q, seen };
}

const statementChars = (s: { sql: string; params: Param[] }) =>
  s.sql.length + s.params.reduce((n: number, p) => n + (p === null ? 4 : String(p).length), 0);

describe("assertIdentifier", () => {
  it("allows a lowercase name with digits after the first letter, and nothing else", () => {
    expect(assertIdentifier("last4")).toBe("last4");
    expect(assertIdentifier("driver_cards")).toBe("driver_cards");
    for (const bad of ["4last", "_x", "Last4", "a-b", "a b", "a;b", 'a"b', ""]) {
      expect(() => assertIdentifier(bad)).toThrow("not a plain identifier");
    }
  });
});

describe("insertStatements", () => {
  it("splits rows into batches of at most 100", () => {
    const out = insertStatements("customers", Array.from({ length: 250 }, (_, i) => customer(i)));
    expect(out.map((s) => s.rows)).toEqual([100, 100, 50]);
    for (const s of out) {
      expect(s.params.length).toBe(s.rows * 8);
      expect(s.params.length).toBeLessThanOrEqual(MAX_PARAMS_PER_INSERT);
      expect(statementChars(s)).toBeLessThan(MAX_STATEMENT_CHARS);
    }
    expect(out[2].params[0]).toBe(customer(200).id);
  });

  it("writes the current tenant into every row and casts what needs it", () => {
    const [s] = insertStatements("customers", [customer(1), customer(2)]);
    expect(s.sql).toBe(
      "INSERT INTO customers (tenant_id, id, code, name, terms_days, city, state, " +
        "detention_free_minutes, detention_hourly_cents) VALUES " +
        "(current_tenant_id(), CAST($1 AS uuid), $2, $3, $4, $5, $6, $7, $8), " +
        "(current_tenant_id(), CAST($9 AS uuid), $10, $11, $12, $13, $14, $15, $16)",
    );
    expect(s.params.slice(0, 8)).toEqual([
      customer(1).id,
      "C1",
      "Invented Customer 1",
      30,
      "Springfield",
      "MO",
      120,
      5000,
    ]);
  });

  it("sends jsonb as JSON text and null as null", () => {
    const rows = [line({ days: 5 }), { ...line(null), seq: 2 }];
    const [s] = insertStatements("settlement_lines", rows);
    expect(s.sql).toContain("CAST($7 AS jsonb), CAST($8 AS jsonb)");
    expect(s.params[6]).toBe('[{"table":"loads","id":"00000000-0000-4000-8000-000000000003"}]');
    expect(s.params[7]).toBe('{"days":5}');
    expect(s.params[15]).toBeNull();
  });

  it("keeps a statement under the character limit by starting a new one", () => {
    const rows = Array.from({ length: 20 }, () => line(null, "x".repeat(6000)));
    const out = insertStatements("settlement_lines", rows);
    expect(out.length).toBeGreaterThan(1);
    expect(out.reduce((n, s) => n + s.rows, 0)).toBe(20);
    for (const s of out) expect(statementChars(s)).toBeLessThanOrEqual(MAX_STATEMENT_CHARS);
  });

  it("refuses a row too large for one statement", () => {
    expect(() => insertStatements("settlement_lines", [line(null, "x".repeat(70000))])).toThrow(
      "settlement_lines[0] is too large",
    );
  });

  it("refuses a missing column or a value of the wrong kind", () => {
    const noState: Record<string, unknown> = customer(1);
    delete noState.state;
    expect(() => insertStatements("customers", [noState])).toThrow("customers[0].state is missing");
    expect(() => insertStatements("customers", [{ ...customer(1), terms_days: "30" }])).toThrow(
      "not a safe integer",
    );
    expect(() => insertStatements("customers", [{ ...customer(1), code: 7 }])).toThrow("not text");
  });

  it("makes no statement for no rows", () => {
    expect(insertStatements("customers", [])).toEqual([]);
  });
});

describe("insertRows", () => {
  it("returns the rows inserted", async () => {
    const { q, seen } = fakeQ((_, params) => params.length / 8);
    const rows = Array.from({ length: 150 }, (_, i) => customer(i));
    await expect(insertRows(q, "customers", rows)).resolves.toBe(150);
    expect(seen).toHaveLength(2);
  });

  it("throws when the database reports fewer rows than it was given", async () => {
    const { q } = fakeQ((_, params) => params.length / 8 - 1);
    await expect(insertRows(q, "customers", [customer(1), customer(2)])).rejects.toThrow(
      "customers: inserted 1 of 2 rows",
    );
  });
});

describe("deleteTenantRows", () => {
  it("deletes the current tenant's rows from every table, children first", async () => {
    const { q, seen } = fakeQ(() => 3);
    const out = await deleteTenantRows(q);
    expect(seen.map((s) => s.sql)).toEqual(
      [...TENANT_TABLES]
        .reverse()
        .map((t) => `DELETE FROM ${t} WHERE tenant_id = current_tenant_id()`),
    );
    expect(Object.keys(out).sort()).toEqual([...TENANT_TABLES].sort());
    expect(Object.values(out).every((n) => n === 3)).toBe(true);
  });
});
