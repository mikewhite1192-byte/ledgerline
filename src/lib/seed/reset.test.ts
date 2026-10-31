import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TENANT_TABLES } from "../data/tables";
import golden from "./golden.json";
import { DEMO_ANCHOR } from "./anchor";
import { DEMO_CARRIERS } from "./carriers";
import {
  CLEARED_TABLES,
  DEMO_RESET_CLEARED,
  DEMO_RESET_KEPT,
  DemoResetRefused,
  FUNCTION_TABLES,
  RESET_SQLSTATE,
  RESET_TABLES,
  TABLE_LABELS,
  refusalText,
} from "./reset";

describe("the demo reset's lists", () => {
  it("resets at the anchor the golden counts were built for", () => {
    expect(DEMO_ANCHOR).toBe(golden.anchor);
  });

  it("gives every table a reset decision in one list only, and a plain label to every one it changes", () => {
    const decided = [...TENANT_TABLES, ...Object.keys(DEMO_RESET_CLEARED), ...Object.keys(DEMO_RESET_KEPT)];
    expect(new Set(decided).size).toBe(decided.length);
    expect(Object.keys(TABLE_LABELS).sort()).toEqual([...RESET_TABLES].sort());
    for (const t of RESET_TABLES) expect(TABLE_LABELS[t].length, t).toBeGreaterThan(2);
    expect([...CLEARED_TABLES, "advances"].sort()).toEqual([...FUNCTION_TABLES].sort());
  });

  it("keeps the error codes the function raises", () => {
    expect(RESET_SQLSTATE).toEqual({ noTenant: "LR001", notDemo: "LR002", refused: "LR003" });
  });
});

// Every migration that creates or re-creates demo_reset_clear(): the last one is the live function,
// and each must keep the gate whole.
const MIGRATIONS = new URL("../../../db/migrations/", import.meta.url);
// Any spelling: either case, any whitespace, with or without OR REPLACE, a public. prefix or quotes.
const DEFINES = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?demo_reset_clear"?\s*\(/i;
const DEFINITIONS = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .filter((f) => DEFINES.test(readFileSync(new URL(f, MIGRATIONS), "utf8")));

describe("the function's demo-carrier gate", () => {
  it("is defined by 0025 first and re-created whole by any later migration", () => {
    expect(DEFINITIONS[0]).toBe("0025_demo_reset.sql");
  });

  // 0033 with the sweep's second checks, 0034 with the fuel checks, 0036 with the pay rule changes,
  // 0038 with the Inbox messages, 0066 with the rate confirmation readings, 0069 with the escrow
  // releases, then 0072 with the agent's questions last, so a fresh database ends on the full union.
  it("is re-created whole by 0033, 0034, 0036, 0038, 0066 and 0069, then 0072 last", () => {
    expect(DEFINITIONS).toContain("0033_demo_reset_fanout.sql");
    expect(DEFINITIONS).toContain("0034_fuel_reset.sql");
    expect(DEFINITIONS).toContain("0036_demo_reset_pay_rule_changes.sql");
    expect(DEFINITIONS).toContain("0038_demo_reset_inbound.sql");
    expect(DEFINITIONS).toContain("0066_ratecon_loads.sql");
    expect(DEFINITIONS).toContain("0069_escrow_releases.sql");
    expect(DEFINITIONS.at(-1)).toBe("0072_agent_asks.sql");
  });

  it("finds a definition in any spelling, and never a call or a longer name", () => {
    for (const sql of [
      "CREATE FUNCTION demo_reset_clear()",
      "create or replace function public.demo_reset_clear()",
      "CREATE  OR\n  REPLACE FUNCTION\tdemo_reset_clear ()",
      'CREATE OR REPLACE FUNCTION "public"."demo_reset_clear"()',
    ]) {
      expect(DEFINES.test(sql)).toBe(true);
    }
    for (const sql of ["SELECT * FROM demo_reset_clear()", "CREATE FUNCTION demo_reset_clear_all()"]) {
      expect(DEFINES.test(sql)).toBe(false);
    }
  });

  it.each(DEFINITIONS)("%s lists exactly the seed carriers, each by slug, name and timezone together, and raises LR002 otherwise", (file) => {
    const sql = readFileSync(new URL(file, MIGRATIONS), "utf8");
    const gate =
      /IF NOT FOUND OR \(\(v_slug, v_name, v_timezone\) IN \(([^;]*?)\)\) IS NOT TRUE THEN\s+RAISE EXCEPTION 'demo reset: not a demo tenant' USING ERRCODE = 'LR002';/.exec(
        sql,
      );
    expect(gate).not.toBeNull();
    const tuple = /\('([^']*)', '([^']*)', '([^']*)'\)/g;
    const listed = [...gate![1].matchAll(tuple)].map(([, slug, name, timezone]) => ({ slug, name, timezone }));
    expect(listed).toEqual(DEMO_CARRIERS.map(({ slug, name, timezone }) => ({ slug, name, timezone })));
    // Nothing else in the list: only those tuples, the commas between them and whitespace.
    expect(gate![1].replace(tuple, "").replace(/[\s,]/g, "")).toBe("");
    // One gate, and no slug-only check left beside it.
    expect(sql.match(/ERRCODE = 'LR002'/g)).toHaveLength(1);
    expect(sql).not.toMatch(/v_slug (NOT )?IN/);
  });

  // Production applies migrations in the order they merged, a fresh database in number order, and
  // each keeps whichever re-creation ran last. Only a newest re-creation that deletes everything
  // every earlier one deletes gives both the same function.
  it("keeps every table an earlier definition deletes in the newest one, which deletes exactly FUNCTION_TABLES", () => {
    const deletes = (file: string) =>
      new Set([...readFileSync(new URL(file, MIGRATIONS), "utf8").matchAll(/DELETE FROM public\.(\w+) /g)].map((m) => m[1]));
    const newest = deletes(DEFINITIONS[DEFINITIONS.length - 1]);
    for (const file of DEFINITIONS) {
      for (const table of deletes(file)) expect(newest.has(table), `${file} deletes ${table}`).toBe(true);
    }
    expect([...newest].sort()).toEqual([...FUNCTION_TABLES].sort());
  });
});

describe("a refusal", () => {
  it("names counts only, and says nothing was cleared", () => {
    expect(refusalText({ kind: "open", count: 2 })).toBe(
      "2 payment record(s) still waiting to send, sent or not confirmed yet; settle them before a reset",
    );
    expect(refusalText({ kind: "mismatch", count: 1 })).toBe(
      "1 payment record(s) failed because the amount did not match; a person must review them before a reset",
    );
    expect(refusalText({ kind: "flagged", count: 3 })).toBe(
      "3 card(s) behind a payment record carry a flag from an outside message; a person must review them before a reset",
    );
    const err = new DemoResetRefused([
      { kind: "open", count: 1 },
      { kind: "mismatch", count: 1 },
    ]);
    expect(err.message).toBe(
      "1 payment record(s) still waiting to send, sent or not confirmed yet; settle them before a reset; " +
        "1 payment record(s) failed because the amount did not match; a person must review them before a reset " +
        "(nothing was cleared)",
    );
  });
});
