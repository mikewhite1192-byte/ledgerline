import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_TABLES } from "../data/tables";
import { createPgDb } from "./pg";
import { adminUrl } from "./test-urls";
import type { Db } from "./types";

// The guard for every later migration: no table in public may exist without forced row-level
// security and exactly one tenant_isolation policy on its tenant column, and the app role may
// own nothing, inherit nothing and see nothing it should not. A new table that skips the
// convention fails here, in CI, before it can reach Aurora.

const TENANT_ONLY = "(tenant_id = current_tenant_id())";

let admin: Db;

type Table = { name: string; rls: boolean; force: boolean; owner: string };
type Policy = {
  policyname: string;
  permissive: string;
  roles: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
};

const tables = () =>
  admin.withoutTenant((q) =>
    q.query<Table>(
      `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'schema_migrations'
        ORDER BY 1`,
    ),
  );

describe("row-level security coverage", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
  });

  afterAll(async () => {
    await admin?.close();
  });

  it("finds the tables (an empty list would make every check below pass)", async () => {
    const names = (await tables()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["memberships", "tenants", ...TENANT_TABLES]));
  });

  it("forces row-level security on every table, owned by someone other than the app", async () => {
    for (const t of await tables()) {
      expect(t, t.name).toMatchObject({ rls: true, force: true });
      expect(t.owner, t.name).not.toBe("payday_app");
    }
  });

  it("gives every table exactly one tenant_isolation policy on its tenant column", async () => {
    for (const t of await tables()) {
      const policies = await admin.withoutTenant((q) =>
        q.query<Policy>(
          `SELECT policyname, permissive, roles::text AS roles, cmd, qual, with_check
             FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
          [t.name],
        ),
      );
      const scope = t.name === "tenants" ? "(id = current_tenant_id())" : TENANT_ONLY;
      expect(policies, t.name).toEqual([
        {
          policyname: "tenant_isolation",
          permissive: "PERMISSIVE",
          roles: "{public}",
          cmd: "ALL",
          qual: scope,
          with_check: scope,
        },
      ]);
      if (t.name !== "tenants") {
        const column = await admin.withoutTenant((q) =>
          q.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'
                AND data_type = 'uuid' AND is_nullable = 'NO'`,
            [t.name],
          ),
        );
        expect(column, `${t.name}.tenant_id`).toHaveLength(1);
      }
    }
  });

  it("has no view or definer function that would read as its owner", async () => {
    const [found] = await admin.withoutTenant((q) =>
      q.query<{ views: number; definers: number }>(
        `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')) AS views,
                (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.prosecdef) AS definers`,
      ),
    );
    expect(found).toEqual({ views: 0, definers: 0 });
  });

  it("keeps the app role plain: no superuser, no bypass, no inherited roles, no migrations table", async () => {
    const [role] = await admin.withoutTenant((q) =>
      q.query(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin,
                (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) AS member_of,
                has_table_privilege(r.oid, 'schema_migrations',
                  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS migrations,
                has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create
           FROM pg_roles r WHERE r.rolname = 'payday_app'`,
      ),
    );
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolinherit: false,
      rolcanlogin: true,
      member_of: 0,
      migrations: false,
      can_create: false,
    });
  });
});
