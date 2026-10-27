import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_TABLES } from "../data/tables";
import { createPgDb } from "../db/pg";
import { adminUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { DEMO_CARRIERS } from "./carriers";
import { CLEARED_TABLES, DEMO_RESET_CLEARED, DEMO_RESET_KEPT, FUNCTION_TABLES } from "./reset";

// The demo reset's coverage guard. Every table in the database has a reset decision: rewritten by
// the seed (TENANT_TABLES), cleared by demo_reset_clear() (DEMO_RESET_CLEARED) or kept
// (DEMO_RESET_KEPT), each listed with why. A migration that adds a table without one fails here,
// in CI, before it reaches Aurora. So does a reference that would make the reset fail or leave a
// dangling row, and a change to what the function deletes.

const SYSTEM_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;

// Public tables by name, any other schema's as schema.name, the way the lists name them.
const qualified = (c: string, n: string) =>
  `CASE WHEN ${n}.nspname = 'public' THEN ${c}.relname ELSE ${n}.nspname || '.' || ${c}.relname END`;

const REWRITTEN = new Set<string>(TENANT_TABLES);
const CLEARED = new Set<string>(CLEARED_TABLES);
const KEPT = new Set<string>(Object.keys(DEMO_RESET_KEPT));

let admin: Db;

type Reference = { name: string; from_table: string; to_table: string; on_delete: string };

const references = () =>
  admin.withoutTenant((q) =>
    q.query<Reference>(
      `SELECT con.conname AS name,
              ${qualified("src", "sn")} AS from_table,
              ${qualified("dst", "dn")} AS to_table,
              con.confdeltype AS on_delete
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace sn ON sn.oid = src.relnamespace
         JOIN pg_class dst ON dst.oid = con.confrelid
         JOIN pg_namespace dn ON dn.oid = dst.relnamespace
        WHERE con.contype = 'f'
        ORDER BY 1`,
    ),
  );

describe("demo reset coverage", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
  });

  afterAll(async () => {
    await admin?.close();
  });

  it("gives every table in the database exactly one reset decision", async () => {
    const found = await admin.withoutTenant((q) =>
      q.query<{ name: string }>(
        `SELECT ${qualified("c", "n")} AS name
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE ${SYSTEM_SCHEMAS} AND c.relkind IN ('r', 'p', 'f')
          ORDER BY 1`,
      ),
    );
    const decided = [...REWRITTEN, ...CLEARED, ...KEPT];
    // Exactly one list each.
    expect(new Set(decided).size).toBe(decided.length);
    // Every table has a decision, and every decision names a table that exists.
    expect(found.map((t) => t.name).sort()).toEqual([...decided].sort());
    // Every decision carries its reason.
    for (const [table, why] of [...Object.entries(DEMO_RESET_CLEARED), ...Object.entries(DEMO_RESET_KEPT)]) {
      expect(why.length, table).toBeGreaterThan(10);
    }
  });

  it("deletes from exactly the cleared tables and the advances an approval created, naming the tenant in every statement", async () => {
    const [fn] = await admin.withoutTenant((q) =>
      q.query<{ body: string }>(
        `SELECT pg_get_functiondef(p.oid) AS body
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'demo_reset_clear'`,
      ),
    );
    expect(fn).toBeDefined();
    // A statement ends at its semicolon; the run and session deletes inside one WITH end at
    // "RETURNING 1" and their closing parenthesis.
    const deletes = [
      ...fn.body.matchAll(/DELETE FROM public\.([a-z_]+)\s+[a-z]+\s+WHERE\s+([\s\S]+?)(?:;|\s+RETURNING 1\s*\))/g),
    ];
    expect(deletes.map((d) => d[1]).sort()).toEqual([...FUNCTION_TABLES].sort());
    expect([...CLEARED_TABLES, "advances"].sort()).toEqual([...FUNCTION_TABLES].sort());
    // No other way to remove a row: every DELETE was matched above, and there is no TRUNCATE.
    expect(fn.body.match(/\bDELETE\b/g)?.length).toBe(deletes.length);
    expect(fn.body).not.toMatch(/\bTRUNCATE\b|\bUPDATE\s+public\.|\bINSERT\b/i);
    for (const [statement, table, where] of deletes) {
      expect(where, statement).toMatch(new RegExp(`^[a-z]{1,2}\\.tenant_id = v_tenant\\b`));
      expect(table, statement).not.toBe("tenants");
    }
    // The tenant is the transaction's own, read once, and the gate is the two demo carriers' slug,
    // name and timezone together.
    expect(fn.body).toContain("v_tenant        uuid := public.current_tenant_id();");
    expect(fn.body).toContain("SELECT t.slug, t.name, t.timezone INTO v_slug, v_name, v_timezone");
    expect(fn.body).toContain("IF NOT FOUND OR ((v_slug, v_name, v_timezone) IN (");
    for (const c of DEMO_CARRIERS) expect(fn.body).toContain(`('${c.slug}', '${c.name}', '${c.timezone}')`);
    expect(fn.body).not.toContain("v_slug NOT IN");
  });

  it("keeps every rewritten and cleared table under its tenant, so the tenant row lock holds back new rows", async () => {
    const toTenants = new Set(
      (await references())
        .filter((r) => r.to_table === "tenants" && r.on_delete === "c")
        .map((r) => r.from_table),
    );
    for (const table of [...REWRITTEN, ...CLEARED]) expect(toTenants.has(table), table).toBe(true);
  });

  it("lets no kept table point at a row the reset deletes, except the gateway log's turn, which clears", async () => {
    const intoDeleted = (await references()).filter(
      (r) => KEPT.has(r.from_table) && (REWRITTEN.has(r.to_table) || CLEARED.has(r.to_table)),
    );
    // confdeltype n = SET NULL.
    expect(intoDeleted).toEqual([
      { name: "gateway_decisions_turn_fk", from_table: "gateway_decisions", to_table: "turns", on_delete: "n" },
    ]);
  });

  it("names every reference from a rewritten table to a cleared one, each handled before the replace", async () => {
    const intoCleared = (await references()).filter(
      (r) => REWRITTEN.has(r.from_table) && CLEARED.has(r.to_table),
    );
    // advances_proposal_fk has no delete action: the function deletes those advances before the
    // proposals. load_accessorials_proposal_fk clears (n = SET NULL): a billed detention charge
    // stays billed until the replace rewrites the table.
    expect(intoCleared).toEqual([
      { name: "advances_proposal_fk", from_table: "advances", to_table: "proposals", on_delete: "a" },
      {
        name: "load_accessorials_proposal_fk",
        from_table: "load_accessorials",
        to_table: "proposals",
        on_delete: "n",
      },
    ]);
  });
});
