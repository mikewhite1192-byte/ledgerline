import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { ForbiddenError } from "../tenant/context";
import { readRole, requireStaff } from "./role";

// Migration 0043 as the app sees it: the judge role on memberships, the demo_sessions table
// (walled off per carrier, narrow grants) and conversations.demo_session_id. Every write below
// runs as payday_app unless it says otherwise.

const A = randomUUID();
const B = randomUUID();
const tag = A.slice(0, 8);
const JUDGE_SUB = `judge-${A}`;
const ADMIN_SUB = `admin-${A}`;
const HASH = "a".repeat(64);

let admin: Db;
let app: Db;

async function sqlStateOf(work: Promise<unknown>): Promise<string | undefined> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return (err as { sqlState?: string }).sqlState;
}

async function seedTenant(id: string, slug: string) {
  await admin.withTenant(id, (q) =>
    q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/New_York')",
      [slug, `Carrier ${slug}`],
    ),
  );
}

async function newVisit(tenantId: string): Promise<string> {
  const [row] = await app.withTenant(tenantId, (q) =>
    q.query<{ id: string }>(
      `INSERT INTO demo_sessions (tenant_id, cognito_sub, expires_at, ip_hash)
       VALUES (current_tenant_id(), $1, now() + interval '2 hours', $2) RETURNING CAST(id AS text) AS id`,
      [JUDGE_SUB, HASH],
    ),
  );
  return row.id;
}

describe("the judge role (0043)", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    await seedTenant(A, `judge-a-${tag}`);
    await seedTenant(B, `judge-b-${tag}`);
    await admin.withTenant(A, async (q) => {
      await q.execute(
        "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'judge')",
        [JUDGE_SUB, `judge@a-${tag}.example`],
      );
      await q.execute(
        "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')",
        [ADMIN_SUB, `ops@a-${tag}.example`],
      );
    });
  });

  afterAll(async () => {
    // Remove only what this file made; memberships, visits and conversations go with their tenant.
    for (const id of [A, B]) {
      await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("keeps the role check under its old name and allows exactly admin, staff and judge", async () => {
    const [check] = await admin.withoutTenant((q) =>
      q.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'public.memberships'::regclass AND conname = 'memberships_role_check'`,
      ),
    );
    expect(check.def).toContain("'judge'");
    const state = await sqlStateOf(
      admin.withTenant(A, (q) =>
        q.execute(
          "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'owner')",
          [`owner-${A}`, `owner@a-${tag}.example`],
        ),
      ),
    );
    expect(state).toBe("23514");
  });

  it("reads a judge's role on the real table, and requireStaff refuses it with the judge reason", async () => {
    const session = (sub: string) => ({ sub, email: "x@example.test", tenantId: A });
    await expect(app.withTenant(A, (q) => readRole(q, session(JUDGE_SUB)))).resolves.toBe("judge");
    const err = await app.withTenant(A, (q) => requireStaff(q, session(JUDGE_SUB))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).reason).toBe("judge");
    await expect(app.withTenant(A, (q) => requireStaff(q, session(ADMIN_SUB)))).resolves.toBe("admin");
    // The same subject in another carrier has no membership there.
    const elsewhere = await app
      .withTenant(B, (q) => readRole(q, { ...session(JUDGE_SUB), tenantId: B }))
      .catch((e: unknown) => e);
    expect(elsewhere).toBeInstanceOf(ForbiddenError);
    expect((elsewhere as ForbiddenError).reason).toBe("membership");
  });

  it("walls a carrier's demo visits off from every other carrier", async () => {
    const visit = await newVisit(A);
    const seenByB = await app.withTenant(B, (q) =>
      q.query("SELECT id FROM demo_sessions WHERE id = CAST($1 AS uuid)", [visit]),
    );
    expect(seenByB).toEqual([]);
    const seenByNone = await app.withoutTenant((q) => q.query("SELECT id FROM demo_sessions"));
    expect(seenByNone).toEqual([]);
    const intoB = await sqlStateOf(
      app.withTenant(A, (q) =>
        q.execute(
          `INSERT INTO demo_sessions (tenant_id, cognito_sub, expires_at)
           VALUES (CAST($1 AS uuid), $2, now() + interval '2 hours')`,
          [B, JUDGE_SUB],
        ),
      ),
    );
    expect(intoB).toBe("42501");
    const updatedFromB = await app.withTenant(B, (q) =>
      q.execute("UPDATE demo_sessions SET turns = turns + 1 WHERE id = CAST($1 AS uuid)", [visit]),
    );
    expect(updatedFromB).toBe(0);
  });

  it("lets the app count a visit's spend and turns, and nothing else", async () => {
    const visit = await newVisit(A);
    const counted = await app.withTenant(A, (q) =>
      q.execute(
        `UPDATE demo_sessions SET spent_nanocents = spent_nanocents + 5, reserved_nanocents = 0,
                turns = turns + 1, last_seen_at = now()
          WHERE id = CAST($1 AS uuid)`,
        [visit],
      ),
    );
    expect(counted).toBe(1);
    for (const sql of [
      "UPDATE demo_sessions SET expires_at = expires_at + interval '1 day' WHERE id = CAST($1 AS uuid)",
      "UPDATE demo_sessions SET cognito_sub = 'someone-else' WHERE id = CAST($1 AS uuid)",
      "DELETE FROM demo_sessions WHERE id = CAST($1 AS uuid)",
    ]) {
      expect(await sqlStateOf(app.withTenant(A, (q) => q.execute(sql, [visit]))), sql).toBe("42501");
    }
  });

  it("refuses a raw address, a visit that ends before it starts and a negative spend", async () => {
    for (const [sql, params] of [
      [
        "INSERT INTO demo_sessions (tenant_id, cognito_sub, expires_at, ip_hash) VALUES (current_tenant_id(), $1, now() + interval '1 hour', $2)",
        [JUDGE_SUB, "203.0.113.7"],
      ],
      [
        "INSERT INTO demo_sessions (tenant_id, cognito_sub, expires_at) VALUES (current_tenant_id(), $1, now() - interval '1 hour')",
        [JUDGE_SUB],
      ],
      [
        "INSERT INTO demo_sessions (tenant_id, cognito_sub, expires_at, spent_nanocents) VALUES (current_tenant_id(), $1, now() + interval '1 hour', -1)",
        [JUDGE_SUB],
      ],
      [
        "INSERT INTO demo_sessions (tenant_id, cognito_sub, expires_at) VALUES (current_tenant_id(), '', now() + interval '1 hour')",
        [],
      ],
    ] as const) {
      expect(await sqlStateOf(app.withTenant(A, (q) => q.execute(sql, [...params]))), sql).toBe("23514");
    }
  });

  it("files a conversation under a visit, and leaves every other conversation with none", async () => {
    const visit = await newVisit(A);
    const [staffConv, visitConv] = [randomUUID(), randomUUID()];
    await app.withTenant(A, async (q) => {
      await q.execute(
        "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)",
        [staffConv, ADMIN_SUB],
      );
      await q.execute(
        `INSERT INTO conversations (id, tenant_id, created_by, demo_session_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid))`,
        [visitConv, JUDGE_SUB, visit],
      );
    });
    const rows = await app.withTenant(A, (q) =>
      q.query<{ id: string; demo_session_id: string | null }>(
        `SELECT CAST(id AS text) AS id, CAST(demo_session_id AS text) AS demo_session_id
           FROM conversations WHERE id IN (CAST($1 AS uuid), CAST($2 AS uuid)) ORDER BY created_by`,
        [staffConv, visitConv],
      ),
    );
    expect(rows).toEqual([
      { id: staffConv, demo_session_id: null },
      { id: visitConv, demo_session_id: visit },
    ]);
  });
});
