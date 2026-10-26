import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb } from "./pg";
import { adminUrl, adminUser, appUrl } from "./test-urls";
import type { Db, Queryable } from "./types";

// Row-level security as the app sees it: tenant A can never see or touch tenant B, and a
// connection with no tenant sees nothing. Every check runs as payday_app, the app's own role.

const A = randomUUID();
const B = randomUUID();
const tag = A.slice(0, 8);

let admin: Db;
let app: Db;

async function seed(tenantId: string, slug: string) {
  // As that tenant, so the fixture also works where the admin is not a superuser.
  await admin.withTenant(tenantId, async (q) => {
    await q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/New_York')",
      [slug, `Carrier ${slug}`],
    );
    await q.execute(
      "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')",
      [`sub-${tenantId}`, `ops@${slug}.example`],
    );
  });
}

async function sqlStateOf(work: Promise<unknown>): Promise<string | undefined> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return (err as { sqlState?: string }).sqlState;
}

const sessionState = (q: Queryable) =>
  q.query<{ pid: number; setting: string | null; tenant: string | null; visible: number }>(
    `SELECT pg_backend_pid() AS pid,
            current_setting('app.tenant_id', true) AS setting,
            current_tenant_id() AS tenant,
            (SELECT count(*) FROM tenants) AS visible`,
  );

describe("row-level security", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    await seed(A, `a-${tag}`);
    await seed(B, `b-${tag}`);
  });

  afterAll(async () => {
    // Remove only what this file made; memberships go with their tenant.
    for (const id of [A, B]) {
      await admin.withTenant(id, (q) =>
        q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"),
      );
    }
    await app?.close();
    await admin?.close();
  });

  it("shows a tenant only its own tenant row and memberships", async () => {
    const [tenants, members] = await app.withTenant(A, async (q) => [
      await q.query<{ id: string }>("SELECT id FROM tenants"),
      await q.query<{ tenant_id: string; cognito_sub: string }>(
        "SELECT tenant_id, cognito_sub FROM memberships",
      ),
    ]);
    expect(tenants).toEqual([{ id: A }]);
    expect(members).toEqual([{ tenant_id: A, cognito_sub: `sub-${A}` }]);
  });

  it("cannot change or delete another tenant's rows", async () => {
    const [updated, deleted] = await app.withTenant(A, async (q) => [
      await q.execute("UPDATE tenants SET name = 'taken over' WHERE id = $1", [B]),
      await q.execute("DELETE FROM memberships WHERE tenant_id = $1", [B]),
    ]);
    expect(updated).toBe(0);
    expect(deleted).toBe(0);
    // Read back as B through the app role (the local admin is a superuser and sees every row).
    const [b] = await app.withTenant(B, (q) =>
      q.query<{ name: string; members: number }>(
        "SELECT name, (SELECT count(*) FROM memberships) AS members FROM tenants",
      ),
    );
    expect(b).toEqual({ name: `Carrier b-${tag}`, members: 1 });
  });

  it("cannot write a row into another tenant", async () => {
    const state = await sqlStateOf(
      app.withTenant(A, (q) =>
        q.execute(
          "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES ($1, $2, 'x@b.example', 'staff')",
          [B, `sub-intruder-${tag}`],
        ),
      ),
    );
    expect(state).toBe("42501");
  });

  it("fails closed with no tenant: no rows, no writes", async () => {
    const [tenants, members] = await app.withoutTenant(async (q) => [
      await q.query("SELECT id FROM tenants"),
      await q.query("SELECT id FROM memberships"),
    ]);
    expect(tenants).toEqual([]);
    expect(members).toEqual([]);
    const state = await sqlStateOf(
      app.withoutTenant((q) =>
        q.execute(
          "INSERT INTO tenants (id, slug, name, timezone) VALUES ($1, $2, 'x', 'UTC')",
          [randomUUID(), `c-${tag}`],
        ),
      ),
    );
    expect(state).toBe("42501");
  });

  it("never leaks the tenant to the next transaction on the same connection", async () => {
    const one = createPgDb({ connectionString: appUrl(), max: 1 });
    try {
      const [during] = await one.withTenant(A, sessionState);
      expect(during).toMatchObject({ setting: A, tenant: A, visible: 1 });

      const [after] = await one.withoutTenant(sessionState);
      expect(after.pid).toBe(during.pid);
      expect(["", null]).toContain(after.setting);
      expect(after.tenant).toBeNull();
      expect(after.visible).toBe(0);

      // The rollback path too: the work throws after the tenant was set.
      let pid = 0;
      await expect(
        one.withTenant(A, async (q) => {
          [{ pid }] = await sessionState(q);
          throw new Error("work failed");
        }),
      ).rejects.toThrow("work failed");
      const [afterRollback] = await one.withoutTenant(sessionState);
      expect(afterRollback.pid).toBe(pid);
      expect(afterRollback.tenant).toBeNull();
      expect(afterRollback.visible).toBe(0);
    } finally {
      await one.close();
    }
  });

  it("rejects a tenant setting that is not a UUID", async () => {
    const state = await sqlStateOf(
      app.withoutTenant(async (q) => {
        await q.query("SELECT set_config('app.tenant_id', 'not-a-uuid', true)");
        return q.query("SELECT id FROM tenants");
      }),
    );
    expect(state).toBe("22P02");
    await expect(app.withTenant("not-a-uuid", async () => 1)).rejects.toThrow(/not a UUID/);
  });

  it("gives the app role no way around the policies", async () => {
    const attempts = [
      "ALTER TABLE tenants DISABLE ROW LEVEL SECURITY",
      "ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY",
      "DROP POLICY tenant_isolation ON tenants",
      "ALTER ROLE payday_app BYPASSRLS",
      `SET ROLE ${adminUser()}`,
      "SELECT version FROM schema_migrations",
      "CREATE TABLE payday_app_owned (id int)",
    ];
    for (const sql of attempts) {
      expect(await sqlStateOf(app.withTenant(A, (q) => q.execute(sql))), sql).toBe("42501");
    }
    // Turning row security off makes a filtered query an error, never an unfiltered read.
    const state = await sqlStateOf(
      app.withTenant(A, async (q) => {
        await q.execute("SET LOCAL row_security = off");
        return q.query("SELECT id FROM tenants");
      }),
    );
    expect(state).toBe("42501");

    const role = await app.withoutTenant((q) =>
      q.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"),
    );
    expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
});
