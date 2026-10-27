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

describe("the function's demo-carrier gate", () => {
  // Every migration that creates or re-creates the function (0025, then 0033 with the sweep's
  // second checks, then 0038 with the Inbox messages), so whichever ran last keeps the same gate.
  const dir = new URL("../../../db/migrations/", import.meta.url);
  const defining = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => /FUNCTION demo_reset_clear\(\)\s+RETURNS/.test(readFileSync(new URL(f, dir), "utf8")));

  it("is defined by 0025 and re-created whole by 0033 and 0038", () => {
    expect(defining[0]).toBe("0025_demo_reset.sql");
    expect(defining).toContain("0033_demo_reset_fanout.sql");
    expect(defining).toContain("0038_demo_reset_inbound.sql");
  });

  it.each(defining)("%s lists exactly the seed carriers, each by slug, name and timezone together, and raises LR002 otherwise", (file) => {
    const sql = readFileSync(new URL(file, dir), "utf8");
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
      new Set([...readFileSync(new URL(file, dir), "utf8").matchAll(/DELETE FROM public\.(\w+) /g)].map((m) => m[1]));
    const newest = deletes(defining[defining.length - 1]);
    for (const file of defining) {
      for (const table of deletes(file)) expect(newest.has(table), `${file} deletes ${table}`).toBe(true);
    }
    expect([...newest].sort()).toEqual([...FUNCTION_TABLES].sort());
  });
});

describe("a refusal", () => {
  it("names counts only, and says nothing was cleared", () => {
    expect(refusalText({ kind: "open", count: 2 })).toBe(
      "2 ledger row(s) still reserved, sent or unknown; settle them before a reset",
    );
    expect(refusalText({ kind: "mismatch", count: 1 })).toBe(
      "1 ledger row(s) failed as amount_mismatch; a person must review them before a reset",
    );
    expect(refusalText({ kind: "flagged", count: 3 })).toBe(
      "3 proposal(s) a ledger row names carry a flag from an outside message; a person must review them before a reset",
    );
    const err = new DemoResetRefused([
      { kind: "open", count: 1 },
      { kind: "mismatch", count: 1 },
    ]);
    expect(err.message).toBe(
      "1 ledger row(s) still reserved, sent or unknown; settle them before a reset; " +
        "1 ledger row(s) failed as amount_mismatch; a person must review them before a reset " +
        "(nothing was cleared)",
    );
  });
});
