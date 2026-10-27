import { describe, expect, it } from "vitest";
import { DbError, type Db, type Queryable } from "../db/types";
import {
  ALLOWED_DEFINERS,
  GLOBAL_TABLES,
  crossReadSql,
  insertProbe,
  judgeRls,
  noTenantReadSql,
  probedTables,
  rowsPerTenantSql,
  type PolicyRow,
  type RlsRows,
  type TableRow,
} from "./rls";

const table = (name: string, over: Partial<TableRow> = {}): TableRow => ({
  name,
  rls: true,
  force: true,
  app_owns: false,
  scope_column: name === "tenants" ? "id" : "tenant_id",
  scope_column_ok: true,
  app_reads_scope: true,
  app_reads_any: true,
  ...over,
});

const policy = (name: string, over: Partial<PolicyRow> = {}): PolicyRow => {
  const scope = name === "tenants" ? "(id = current_tenant_id())" : "(tenant_id = current_tenant_id())";
  return {
    table_name: name,
    name: "tenant_isolation",
    permissive: "PERMISSIVE",
    roles: "{public}",
    cmd: "ALL",
    qual: scope,
    with_check: scope,
    ...over,
  };
};

const TABLES = ["drivers", "settlements", "tenants"];

function clean(): RlsRows {
  return {
    catalog: {
      tables: TABLES.map((t) => table(t)),
      policies: TABLES.map((t) => policy(t)),
      globals: [{ name: "ops.ai_spend", app_owns: false, tenant_column: false, app_can: false }],
      ownerReads: [{ views: 0, definers: "", app_creates_in_ops: false }],
      role: [
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolinherit: false,
          rolcanlogin: true,
          member_of: 0,
          migrations: false,
          can_create: false,
        },
      ],
      looseReferences: [{ loose: 0 }],
    },
    live: {
      admin: { rows: { drivers: { a_rows: 5, b_rows: 7 }, settlements: { a_rows: 3, b_rows: 0 }, tenants: { a_rows: 1, b_rows: 1 } } },
      asA: { rows: { drivers: { foreign_rows: 0, other_rows: 0, seen: 5 }, settlements: { foreign_rows: 0, other_rows: 0, seen: 3 }, tenants: { foreign_rows: 0, other_rows: 0, seen: 1 } } },
      asB: { rows: { drivers: { foreign_rows: 0, other_rows: 0, seen: 7 }, settlements: { foreign_rows: 0, other_rows: 0, seen: 0 }, tenants: { foreign_rows: 0, other_rows: 0, seen: 1 } } },
      asNone: { rows: { drivers: { seen: 0 }, settlements: { seen: 0 }, tenants: { seen: 0 } } },
    },
    insert: "refused",
  };
}

describe("judgeRls", () => {
  it("passes when every table is walled off, live and in the catalog", () => {
    const r = judgeRls(clean());
    expect(r.verdict).toBe("PASS");
    expect(r.counts).toEqual({ tables: 3, probed: 3, both_tenants: 2, no_select: 0 });
  });

  it("starts with no extra global tables or definer functions", () => {
    expect(GLOBAL_TABLES).toEqual(["ops.ai_spend"]);
    expect(ALLOWED_DEFINERS).toEqual([]);
  });

  it("catches a new tenant table with row security off, not forced, or owned by the app", () => {
    const rows = clean();
    rows.catalog.tables.push(table("fresh", { rls: false, force: false, app_owns: true }));
    rows.catalog.policies.push(policy("fresh"));
    expect(judgeRls(rows).violations).toEqual({ "rls_off:fresh": 1, "rls_not_forced:fresh": 1, "app_owns:fresh": 1 });
  });

  it("catches a tenant table with no policy", () => {
    const rows = clean();
    rows.catalog.tables.push(table("fresh"));
    expect(judgeRls(rows).violations).toEqual({ "policy_off:fresh": 1 });
  });

  it("catches a policy that is loose, extra, or scoped to anything but the tenant", () => {
    const changes: Partial<PolicyRow>[] = [
      { qual: "true" },
      { with_check: null },
      { cmd: "SELECT" },
      { permissive: "RESTRICTIVE" },
      { roles: "{payday_app}" },
      { name: "open_door" },
      { qual: "(id = current_tenant_id())" },
    ];
    for (const change of changes) {
      const rows = clean();
      rows.catalog.policies = rows.catalog.policies.map((p) => (p.table_name === "drivers" ? { ...p, ...change } : p));
      expect(judgeRls(rows).violations).toEqual({ "policy_off:drivers": 1 });
    }
    const extra = clean();
    extra.catalog.policies.push(policy("drivers", { name: "leak", qual: "true", with_check: null }));
    expect(judgeRls(extra).violations).toEqual({ "policy_off:drivers": 1 });
  });

  it("catches a tenant column that is missing, nullable or not a uuid", () => {
    const rows = clean();
    rows.catalog.tables[0] = table("drivers", { scope_column_ok: false });
    // Not probed live either: the probe cannot scope it.
    const r = judgeRls(rows);
    expect(r.violations).toEqual({ "tenant_column_off:drivers": 1 });
    expect(r.counts.probed).toBe(2);
  });

  it("counts a table the app cannot read, and is UNKNOWN when it reads the table but not its tenant column", () => {
    const hidden = clean();
    hidden.catalog.tables[1] = table("settlements", { app_reads_scope: false, app_reads_any: false });
    const r = judgeRls(hidden);
    expect(r.verdict).toBe("PASS");
    expect(r.counts.no_select).toBe(1);
    const partial = clean();
    partial.catalog.tables[1] = table("settlements", { app_reads_scope: false, app_reads_any: true });
    expect(judgeRls(partial).unknown).toEqual(["unprobed:settlements"]);
  });

  it("catches a table outside public, and the spend counter opened to the app", () => {
    const rows = clean();
    rows.catalog.globals.push({ name: "ops.side_door", app_owns: false, tenant_column: true, app_can: false });
    rows.catalog.globals[0] = { ...rows.catalog.globals[0], app_can: true };
    expect(judgeRls(rows).violations).toEqual({
      "global_table_unexpected:ops.side_door": 1,
      "global_table_off:ops.ai_spend": 1,
    });
  });

  it("catches a view, a definer function and the app creating tables in ops", () => {
    const rows = clean();
    rows.catalog.ownerReads = [{ views: 1, definers: "public.read_all,ops.peek", app_creates_in_ops: true }];
    expect(judgeRls(rows).violations).toEqual({ view_present: 1, definer_function: 2, app_creates_in_ops: 1 });
  });

  it("catches an app role that can bypass row security or reach the migrations table", () => {
    for (const attr of ["rolsuper", "rolbypassrls", "rolinherit", "migrations", "can_create"]) {
      const rows = clean();
      rows.catalog.role = [{ ...rows.catalog.role[0], [attr]: true }];
      expect(judgeRls(rows).violations).toEqual({ [`app_role_off:${attr}`]: 1 });
    }
    const member = clean();
    member.catalog.role = [{ ...member.catalog.role[0], member_of: 1 }];
    expect(judgeRls(member).violations).toEqual({ "app_role_off:member_of": 1 });
    const missing = clean();
    missing.catalog.role = [];
    expect(judgeRls(missing).violations).toEqual({ app_role_missing: 1 });
  });

  it("catches a reference between tenant tables that does not carry the tenant", () => {
    const rows = clean();
    rows.catalog.looseReferences = [{ loose: 2 }];
    expect(judgeRls(rows).violations).toEqual({ loose_reference: 2 });
  });

  it("catches the app seeing the other carrier's rows, either way round", () => {
    const rows = clean();
    if (!rows.live || !("rows" in rows.live.asA) || !("rows" in rows.live.asB)) throw new Error("fixture");
    rows.live.asA.rows.drivers = { foreign_rows: 7, other_rows: 7, seen: 12 };
    rows.live.asB.rows.settlements = { foreign_rows: 1, other_rows: 0, seen: 1 };
    expect(judgeRls(rows).violations).toEqual({ "cross_tenant_rows:drivers": 1, "cross_tenant_rows:settlements": 1 });
  });

  it("catches rows seen with no carrier set", () => {
    const rows = clean();
    if (!rows.live || !("rows" in rows.live.asNone)) throw new Error("fixture");
    rows.live.asNone.rows.drivers = { seen: 12 };
    expect(judgeRls(rows).violations).toEqual({ "no_tenant_rows:drivers": 1 });
  });

  it("catches an insert that went through with no carrier set", () => {
    const rows = clean();
    rows.insert = "accepted";
    expect(judgeRls(rows).violations).toEqual({ insert_not_refused: 1 });
  });

  it("is UNKNOWN when the probe could not see what it was looking for", () => {
    const fewer = clean();
    if (!fewer.live || !("rows" in fewer.live.asA)) throw new Error("fixture");
    fewer.live.asA.rows.drivers = { foreign_rows: 0, other_rows: 0, seen: 4 };
    expect(judgeRls(fewer)).toMatchObject({ verdict: "UNKNOWN", unknown: ["own_rows_mismatch:drivers"] });

    const failed = clean();
    if (!failed.live) throw new Error("fixture");
    failed.live.asB = { failed: "read_failed_rls_denied_42501" };
    expect(judgeRls(failed)).toMatchObject({ verdict: "UNKNOWN", unknown: ["read_failed_rls_denied_42501:as_b"] });

    const noPair = clean();
    noPair.live = null;
    expect(judgeRls(noPair)).toMatchObject({ verdict: "UNKNOWN", unknown: ["tenant_pair_missing"] });

    const unclear = clean();
    unclear.insert = "unclear";
    expect(judgeRls(unclear)).toMatchObject({ verdict: "UNKNOWN", unknown: ["insert_probe_unclear"] });

    const skipped = clean();
    if (!skipped.live || !("rows" in skipped.live.asNone)) throw new Error("fixture");
    delete skipped.live.asNone.rows.tenants;
    expect(judgeRls(skipped)).toMatchObject({ verdict: "UNKNOWN", unknown: ["unprobed:tenants"] });
  });

  it("is UNKNOWN when the other carrier has no rows anywhere, so the probe proves nothing", () => {
    const rows = clean();
    if (!rows.live || !("rows" in rows.live.admin) || !("rows" in rows.live.asB)) throw new Error("fixture");
    for (const t of TABLES) {
      rows.live.admin.rows[t] = { ...rows.live.admin.rows[t], b_rows: 0 };
      rows.live.asB.rows[t] = { foreign_rows: 0, other_rows: 0, seen: 0 };
    }
    expect(judgeRls(rows)).toMatchObject({ verdict: "UNKNOWN", unknown: ["other_tenant_empty"] });
  });

  it("is still FAIL on a leak when another side was unreadable", () => {
    const rows = clean();
    if (!rows.live || !("rows" in rows.live.asA)) throw new Error("fixture");
    rows.live.asB = { failed: "read_failed_timeout" };
    rows.live.asA.rows.drivers = { foreign_rows: 1, other_rows: 1, seen: 6 };
    const r = judgeRls(rows);
    expect(r.verdict).toBe("FAIL");
    expect(r.unknown).toEqual(["read_failed_timeout:as_b"]);
  });

  it("names an odd table as unnamed, never echoing it", () => {
    const rows = clean();
    rows.catalog.tables.push(table("Weird Name", { rls: false }));
    rows.catalog.policies.push(policy("Weird Name"));
    expect(judgeRls(rows).violations).toEqual({ "rls_off:unnamed": 1 });
  });
});

describe("probedTables", () => {
  it("probes every table with a sound tenant column the app may read", () => {
    const tables = [table("drivers"), table("tenants"), table("hidden", { app_reads_scope: false }), table("odd", { scope_column_ok: false })];
    expect(probedTables(tables)).toEqual([
      { name: "drivers", column: "tenant_id" },
      { name: "tenants", column: "id" },
    ]);
  });
});

describe("probe SQL", () => {
  it("quotes plain identifiers and refuses anything else", () => {
    expect(crossReadSql("drivers", "tenant_id")).toContain('FROM public."drivers"');
    expect(noTenantReadSql("tenants")).toBe('SELECT count(*) AS seen FROM public."tenants"');
    expect(rowsPerTenantSql("tenants", "id")).toContain('"id" = CAST($1 AS uuid)');
    for (const bad of ['drivers"; DROP TABLE x; --', "Drivers", "a b", ""]) {
      expect(() => crossReadSql(bad, "tenant_id")).toThrow("odd_table_name");
      expect(() => noTenantReadSql(bad)).toThrow("odd_table_name");
      expect(() => rowsPerTenantSql("drivers", bad)).toThrow("odd_table_name");
    }
  });

  it("counts any row not the set carrier's, including a NULL tenant", () => {
    expect(crossReadSql("drivers", "tenant_id")).toContain('"tenant_id" IS DISTINCT FROM CAST($1 AS uuid)');
  });
});

describe("insertProbe", () => {
  const appWith = (onExecute: () => Promise<number>): Db => ({
    withTenant: async () => {
      throw new Error("not used");
    },
    withoutTenant: async <T>(fn: (q: Queryable) => Promise<T>) => {
      const q: Queryable = { query: async () => [], execute: onExecute };
      return fn(q);
    },
    close: async () => {},
  });

  it("is refused on 42501", async () => {
    expect(await insertProbe(appWith(() => Promise.reject(new DbError("rls_denied", "42501"))))).toBe("refused");
  });

  it("is accepted when the insert went through, and rolls it back", async () => {
    let rolledBack = false;
    const app: Db = {
      ...appWith(() => Promise.resolve(1)),
      withoutTenant: async <T>(fn: (q: Queryable) => Promise<T>) => {
        try {
          return await fn({ query: async () => [], execute: async () => 1 });
        } catch (err) {
          rolledBack = true;
          throw err;
        }
      },
    };
    expect(await insertProbe(app)).toBe("accepted");
    expect(rolledBack).toBe(true);
  });

  it("is unclear on any other error", async () => {
    expect(await insertProbe(appWith(() => Promise.reject(new DbError("timeout", "57014"))))).toBe("unclear");
    expect(await insertProbe(appWith(() => Promise.reject(new DbError("sql", "23505"))))).toBe("unclear");
    expect(await insertProbe(appWith(() => Promise.reject(new Error("socket closed"))))).toBe("unclear");
  });
});
