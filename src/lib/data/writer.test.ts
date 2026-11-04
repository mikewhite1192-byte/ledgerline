import { describe, expect, it } from "vitest";
import type { Param, Queryable } from "../db";
import { APP_KEEPS_TABLES, assertIdentifier, TENANT_TABLES } from "./tables";
import { DEMO_CARRIERS } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { DEMO_ANCHOR } from "../seed/anchor";
import {
  COPY_INSERT_LIMITS,
  DEFAULT_INSERT_LIMITS,
  deleteTenantRows,
  insertRows,
  insertStatements,
  MAX_PARAMS_PER_INSERT,
  MAX_STATEMENT_CHARS,
  WIPE_MARK_SQL,
  type InsertLimits,
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
  pod_required: false,
  billing_email: `ar@c${i}.example`,
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
  entered_by: null,
  source_ref: null,
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

// The characters as the Data API gets them: each $n is sent as :pn, one character longer.
const sentChars = (s: { sql: string; params: Param[] }) => statementChars(s) + (s.sql.match(/\$\d+/g) ?? []).length;

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
      expect(s.params.length).toBe(s.rows * 10);
      expect(s.params.length).toBeLessThanOrEqual(MAX_PARAMS_PER_INSERT);
      expect(statementChars(s)).toBeLessThan(MAX_STATEMENT_CHARS);
    }
    expect(out[2].params[0]).toBe(customer(200).id);
  });

  it("writes the current tenant into every row and casts what needs it", () => {
    const [s] = insertStatements("customers", [customer(1), customer(2)]);
    expect(s.sql).toBe(
      "INSERT INTO customers (tenant_id, id, code, name, terms_days, city, state, " +
        "detention_free_minutes, detention_hourly_cents, pod_required, billing_email) VALUES " +
        "(current_tenant_id(), CAST($1 AS uuid), $2, $3, $4, $5, $6, $7, $8, $9, $10), " +
        "(current_tenant_id(), CAST($11 AS uuid), $12, $13, $14, $15, $16, $17, $18, $19, $20)",
    );
    expect(s.params.slice(0, 10)).toEqual([
      customer(1).id,
      "C1",
      "Invented Customer 1",
      30,
      "Springfield",
      "MO",
      120,
      5000,
      false,
      "ar@c1.example",
    ]);
  });

  it("sends jsonb as JSON text and null as null", () => {
    const rows = [line({ days: 5 }), { ...line(null), seq: 2 }];
    const [s] = insertStatements("settlement_lines", rows);
    expect(s.sql).toContain("CAST($7 AS jsonb), CAST($8 AS jsonb)");
    expect(s.params[6]).toBe('[{"table":"loads","id":"00000000-0000-4000-8000-000000000003"}]');
    expect(s.params[7]).toBe('{"days":5}');
    expect(s.params[17]).toBeNull();
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
    expect(() => insertStatements("customers", [{ ...customer(1), pod_required: "false" }])).toThrow(
      "not a boolean",
    );
  });

  it("makes no statement for no rows", () => {
    expect(insertStatements("customers", [])).toEqual([]);
  });
});

describe("insertStatements with other limits", () => {
  const rowsOf = (out: { params: Param[] }[]) => out.flatMap((st) => st.params);
  const at = (limits: Partial<InsertLimits>): InsertLimits => ({ ...COPY_INSERT_LIMITS, ...limits });

  it("is the demo reset's batching when no limits are passed", () => {
    const rows = Array.from({ length: 250 }, (_, i) => customer(i));
    expect(insertStatements("customers", rows, DEFAULT_INSERT_LIMITS)).toEqual(insertStatements("customers", rows));
  });

  it("stops a batch at the row cap", () => {
    const out = insertStatements("customers", Array.from({ length: 25 }, (_, i) => customer(i)), at({ rows: 10 }));
    expect(out.map((st) => st.rows)).toEqual([10, 10, 5]);
  });

  it("stops a batch at the parameter cap, in whole rows", () => {
    // Ten columns a row: 35 parameters hold three rows, never three and a half.
    const out = insertStatements("customers", Array.from({ length: 7 }, (_, i) => customer(i)), at({ params: 35 }));
    expect(out.map((st) => st.rows)).toEqual([3, 3, 1]);
    for (const st of out) expect(st.params.length).toBeLessThanOrEqual(35);
  });

  it("refuses limits that allow no row", () => {
    expect(() => insertStatements("customers", [customer(1)], at({ params: 9 }))).toThrow("allow no row");
  });

  it("stops a batch at the character budget, exactly at the boundary, counted as sent", () => {
    const rows = Array.from({ length: 6 }, (_, i) => customer(i));
    const one = insertStatements("customers", rows.slice(0, 2), at({ chars: 1_000_000 }))[0];
    // The writer counts a ", " after every tuple, the last included: a budget of the two rows as
    // sent plus those two characters holds both, and one character less holds one.
    const exact = sentChars(one) + 2;
    expect(insertStatements("customers", rows.slice(0, 2), at({ chars: exact })).map((st) => st.rows)).toEqual([2]);
    expect(insertStatements("customers", rows.slice(0, 2), at({ chars: exact - 1 })).map((st) => st.rows)).toEqual([1, 1]);
    for (const st of insertStatements("customers", rows, at({ chars: exact }))) {
      expect(sentChars(st)).toBeLessThanOrEqual(exact);
    }
  });

  it("puts a row with long text in a batch of its own when only it fits, and refuses one past the budget", () => {
    // As long as the budget lets one row be, with 100 characters to spare: less than another row.
    const alone = sentChars(insertStatements("customers", [customer(2)])[0]) + 2;
    const long = { ...customer(2), name: "x".repeat(COPY_INSERT_LIMITS.chars - alone + customer(2).name.length - 100) };
    const out = insertStatements("customers", [customer(1), long, customer(3)], COPY_INSERT_LIMITS);
    expect(out.map((st) => st.rows)).toEqual([1, 1, 1]);
    expect(out[1].params[2]).toBe(long.name);
    for (const st of out) expect(sentChars(st)).toBeLessThanOrEqual(COPY_INSERT_LIMITS.chars);
    // The demo reset's budget still takes a row this long; the copy's refuses it.
    const longer = { ...customer(2), name: "x".repeat(61_000) };
    expect(insertStatements("customers", [longer])).toHaveLength(1);
    expect(() => insertStatements("customers", [longer], COPY_INSERT_LIMITS)).toThrow("customers[0] is too large");
  });

  it("writes every row of every demo carrier once, in order, in fewer statements than the demo reset, each under the Data API's limit", () => {
    for (const c of DEMO_CARRIERS) {
      const plan = buildCarrierPlan(c, DEMO_ANCHOR);
      let copy = 0;
      let reset = 0;
      for (const table of TENANT_TABLES) {
        const rows = plan.rows[table] as readonly Record<string, unknown>[];
        const fuller = insertStatements(table, rows, COPY_INSERT_LIMITS);
        const plain = insertStatements(table, rows);
        // The same parameters in the same order: the same rows, only cut in other places.
        expect(rowsOf(fuller), table).toEqual(rowsOf(plain));
        expect(fuller.reduce((n, st) => n + st.rows, 0), table).toBe(rows.length);
        expect(fuller.length, table).toBeLessThanOrEqual(plain.length);
        for (const st of fuller) {
          expect(st.rows).toBeLessThanOrEqual(COPY_INSERT_LIMITS.rows);
          expect(st.params.length).toBeLessThanOrEqual(COPY_INSERT_LIMITS.params);
          expect(sentChars(st)).toBeLessThanOrEqual(COPY_INSERT_LIMITS.chars);
          expect(st.sql.length + (st.sql.match(/\$\d+/g) ?? []).length).toBeLessThan(MAX_STATEMENT_CHARS);
          // Every tuple writes the current tenant.
          expect(st.sql.split("(current_tenant_id(), ").length - 1).toBe(st.rows);
        }
        copy += fuller.length;
        reset += plain.length;
      }
      expect(copy).toBeLessThan(reset * 0.75);
    }
  });
});

describe("insertRows", () => {
  it("returns the rows inserted", async () => {
    const { q, seen } = fakeQ((_, params) => params.length / 10);
    const rows = Array.from({ length: 150 }, (_, i) => customer(i));
    await expect(insertRows(q, "customers", rows)).resolves.toBe(150);
    expect(seen).toHaveLength(2);
  });

  it("sends the batches the limits make, and the same rows", async () => {
    const { q, seen } = fakeQ((_, params) => params.length / 10);
    const rows = Array.from({ length: 150 }, (_, i) => customer(i));
    await expect(insertRows(q, "customers", rows, COPY_INSERT_LIMITS)).resolves.toBe(150);
    expect(seen).toHaveLength(1);
    expect(seen[0].params).toEqual(insertStatements("customers", rows).flatMap((st) => st.params));
  });

  it("throws when the database reports fewer rows than it was given", async () => {
    const { q } = fakeQ((_, params) => params.length / 10 - 1);
    await expect(insertRows(q, "customers", [customer(1), customer(2)])).rejects.toThrow(
      "customers: inserted 1 of 2 rows",
    );
  });
});

describe("deleteTenantRows", () => {
  it("marks the transaction as the tenant's wipe, then deletes its rows from every table, children first", async () => {
    const { q, seen } = fakeQ(() => 3);
    const out = await deleteTenantRows(q);
    expect(seen.map((s) => s.sql)).toEqual([
      WIPE_MARK_SQL,
      ...[...TENANT_TABLES]
        .reverse()
        .filter((t) => !APP_KEEPS_TABLES.has(t))
        .map((t) => `DELETE FROM ${t} WHERE tenant_id = current_tenant_id()`),
    ]);
    expect(Object.keys(out).sort()).toEqual([...TENANT_TABLES].sort());
    expect(Object.entries(out).every(([t, n]) => n === (APP_KEEPS_TABLES.has(t as never) ? 0 : 3))).toBe(true);
  });

  it("never deletes from the arming log or the phone line's calls, which the app role may only add to", async () => {
    expect([...APP_KEEPS_TABLES]).toEqual([
      "driver_arm_events",
      "driver_status_events",
      "driver_activation_steps",
      "calls",
      "call_segments",
      "call_turns",
    ]);
    const { q, seen } = fakeQ(() => 0);
    await deleteTenantRows(q);
    for (const table of APP_KEEPS_TABLES) {
      expect(seen.some((s) => new RegExp(`DELETE FROM ${table} `).test(s.sql)), table).toBe(false);
    }
  });
});
