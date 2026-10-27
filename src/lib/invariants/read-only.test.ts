import { describe, expect, it } from "vitest";
import type { Db, Param, Queryable } from "../db/types";
import * as approvals from "./approvals";
import * as keys from "./keys";
import * as ledger from "./ledger";
import * as modelCalls from "./model-calls";
import * as rls from "./rls";
import { READ_ONLY_SNAPSHOT_SQL, READ_ONLY_SQL, isReadSql, readAll, readAs } from "./types";

// Every statement the checks send is one SELECT; the only exceptions are the two statements that
// make a transaction read-only and the row security probe's insert, which must be refused.
const NOT_SELECT = new Set([READ_ONLY_SNAPSHOT_SQL, READ_ONLY_SQL, rls.INSERT_PROBE_SQL]);

describe("every statement is read-only", () => {
  const modules = { approvals, keys, ledger, modelCalls, rls };

  it("exports only SELECT statements", () => {
    let seen = 0;
    for (const mod of Object.values(modules)) {
      for (const [name, value] of Object.entries(mod)) {
        if (!name.endsWith("_SQL") || typeof value !== "string") continue;
        seen += 1;
        if (NOT_SELECT.has(value)) continue;
        expect(isReadSql(value), name).toBe(true);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(20);
  });

  it("builds only SELECT statements for the live probe", () => {
    expect(isReadSql(rls.crossReadSql("drivers", "tenant_id"))).toBe(true);
    expect(isReadSql(rls.noTenantReadSql("drivers"))).toBe(true);
    expect(isReadSql(rls.rowsPerTenantSql("tenants", "id"))).toBe(true);
  });

  it("the insert probe is the only write, and it names no real carrier", () => {
    expect(rls.INSERT_PROBE_SQL.trim().startsWith("INSERT INTO tenants")).toBe(true);
    expect(rls.INSERT_PROBE_SQL).toContain("'rls-probe'");
  });
});

describe("read transactions", () => {
  type Call = { kind: "query" | "execute"; sql: string; params?: Param[] };

  const recording = (calls: Call[], tenants: (string | null)[]): Db => {
    const q: Queryable = {
      query: async <T>(sql: string, params?: Param[]) => {
        calls.push({ kind: "query", sql, params });
        return [] as T[];
      },
      execute: async (sql: string, params?: Param[]) => {
        calls.push({ kind: "execute", sql, params });
        return 0;
      },
    };
    return {
      withTenant: async (tenantId, fn) => {
        tenants.push(tenantId);
        return fn(q);
      },
      withoutTenant: async (fn) => {
        tenants.push(null);
        return fn(q);
      },
      close: async () => {},
    };
  };

  it("readAll opens a read-only snapshot before any read", async () => {
    const calls: Call[] = [];
    const tenants: (string | null)[] = [];
    await readAll(recording(calls, tenants), (q) => q.query("SELECT 1"));
    expect(tenants).toEqual([null]);
    expect(calls.map((c) => c.sql)).toEqual([READ_ONLY_SNAPSHOT_SQL, "SELECT 1"]);
  });

  it("readAs sets the transaction read-only, with or without a carrier", async () => {
    const calls: Call[] = [];
    const tenants: (string | null)[] = [];
    const db = recording(calls, tenants);
    await readAs(db, "00000000-0000-4000-8000-000000000001", (q) => q.query("SELECT 2"));
    await readAs(db, null, (q) => q.query("SELECT 3"));
    expect(tenants).toEqual(["00000000-0000-4000-8000-000000000001", null]);
    expect(calls.map((c) => c.sql)).toEqual([READ_ONLY_SQL, "SELECT 2", READ_ONLY_SQL, "SELECT 3"]);
  });

  it("a check's handle cannot write", async () => {
    const calls: Call[] = [];
    await expect(
      readAll(recording(calls, []), (q) => q.query("UPDATE settlements SET net_cents = 0")),
    ).rejects.toMatchObject({ category: "refused_not_select" });
    expect(calls.map((c) => c.sql)).toEqual([READ_ONLY_SNAPSHOT_SQL]);
  });
});
