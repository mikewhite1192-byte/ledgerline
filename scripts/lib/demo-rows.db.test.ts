import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb } from "../../src/lib/db/pg";
import { adminUrl } from "../../src/lib/db/test-urls";
import type { Db } from "../../src/lib/db/types";
import { ensureRows, type DemoCarrier, type DemoMember } from "./demo-rows";

// On Aurora the admin login that runs the demo user script (the cluster's master user) is not
// held by row-level security. This stands in for it with a throwaway role that has BYPASSRLS and
// is not a superuser, runs the script's own statements through it for two carriers, and checks
// that each run reads and writes only its own carrier.

const A = randomUUID();
const B = randomUUID();
const tag = A.slice(0, 8);
// A role name cannot be a bind parameter, so it is built from hex digits and checked.
const ROLE = `payday_bypass_${tag}`;

const carrier = (prefix: string, timezone: string): DemoCarrier => ({
  slug: `${prefix}-${tag}`,
  name: `Carrier ${prefix}-${tag}`,
  timezone,
  email: `ops@${prefix}-${tag}.example`,
});
// The carrier's admin login, as the script passes it.
const adminOf = (c: DemoCarrier, sub: string): DemoMember => ({ sub, email: c.email, role: "admin" });
const carrierA = carrier("a", "America/New_York");
const carrierB = carrier("b", "America/Chicago");

// Every tenant id this file may have written, removed in afterAll.
const made = new Set([A, B]);

let admin: Db;
let master: Db;

// One carrier's rows, whole, read by the local superuser scoped to that carrier.
const rowsOf = (tenantId: string) =>
  admin.withTenant(tenantId, async (q) => ({
    tenants: await q.query(
      "SELECT id, slug, name, timezone, created_at FROM tenants WHERE id = current_tenant_id()",
    ),
    members: await q.query(
      `SELECT id, tenant_id, cognito_sub, email, role, created_at FROM memberships
        WHERE tenant_id = current_tenant_id() ORDER BY cognito_sub`,
    ),
    rules: await q.query(
      `SELECT id, kind, mode, max_cents, day_max_cents, day_max_count, version, updated_by FROM autopilot_rules
        WHERE tenant_id = current_tenant_id() ORDER BY kind`,
    ),
  }));

describe("demo rows through a login that skips row-level security", () => {
  beforeAll(async () => {
    if (!/^payday_bypass_[0-9a-f]{8}$/.test(ROLE)) throw new Error("role name is not plain");
    admin = createPgDb({ connectionString: adminUrl() });
    await admin.withoutTenant(async (q) => {
      await q.execute(
        `CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS`,
      );
      await q.execute(`GRANT SELECT, INSERT ON tenants, memberships, autopilot_rules TO ${ROLE}`);
      // A new tenant's document key comes from this sequence (0015). The master user that runs the
      // migrations owns it on Aurora, so the stand-in gets the same use of it.
      await q.execute(`GRANT USAGE ON SEQUENCE tenant_doc_key_seq TO ${ROLE}`);
    });
    const url = new URL(adminUrl());
    url.username = ROLE;
    url.password = "";
    master = createPgDb({ connectionString: url.toString() });
  });

  afterAll(async () => {
    try {
      // Memberships go with their tenant. One failed delete does not stop the others.
      for (const id of made) {
        try {
          await admin.withTenant(id, (q) =>
            q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"),
          );
        } catch {
          // keep going; the role and the pool are still cleaned up below
        }
      }
    } finally {
      try {
        try {
          await master?.close();
        } catch {
          // the role is dropped even when its pool fails to close
        }
        await admin?.withoutTenant(async (q) => {
          const role = await q.query("SELECT 1 AS ok FROM pg_roles WHERE rolname = $1", [ROLE]);
          if (role.length === 0) return;
          await q.execute(`DROP OWNED BY ${ROLE}`);
          await q.execute(`DROP ROLE ${ROLE}`);
        });
      } finally {
        await admin?.close();
      }
    }
  });

  it("writes the first carrier", async () => {
    await ensureRows(master, carrierA, A, adminOf(carrierA, `sub-${A}`));
    const a = await rowsOf(A);
    expect(a.tenants).toMatchObject([{ id: A, slug: carrierA.slug }]);
    expect(a.members).toMatchObject([
      { cognito_sub: `service:autopilot:${A}`, email: `autopilot@${carrierA.slug}.invalid`, role: "staff" },
      { cognito_sub: `service:sweep:${A}`, email: `sweep@${carrierA.slug}.invalid`, role: "staff" },
      { cognito_sub: `sub-${A}`, email: carrierA.email, role: "admin" },
    ]);
    // The starting autopilot rules: Auto on the three kinds that move no money out of the company.
    expect(a.rules).toMatchObject([
      { kind: "card_match", mode: "auto", max_cents: 50000, day_max_cents: 300000, day_max_count: 40, version: 1, updated_by: "setup" },
      { kind: "invoice_post", mode: "auto", max_cents: 200000, day_max_cents: 1000000, day_max_count: 25, version: 1 },
      { kind: "payment_reapply", mode: "auto", max_cents: 200000, day_max_cents: 1000000, day_max_count: 25, version: 1 },
    ]);
  });

  it("stands in for the Aurora master: with tenant B set it still reads tenant A", async () => {
    const [role] = await master.withoutTenant((q) =>
      q.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"),
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: true });
    // Without this the checks below could pass because the policies held the role.
    const seen = await master.withTenant(B, (q) =>
      q.query("SELECT slug FROM tenants WHERE slug = $1", [carrierA.slug]),
    );
    expect(seen).toEqual([{ slug: carrierA.slug }]);
  });

  it("writes the second carrier and leaves the first untouched", async () => {
    const before = await rowsOf(A);
    await ensureRows(master, carrierB, B, adminOf(carrierB, `sub-${B}`));
    expect(await rowsOf(A)).toEqual(before);
    const b = await rowsOf(B);
    expect(b.tenants).toMatchObject([{ id: B, slug: carrierB.slug }]);
    expect(b.members).toMatchObject([
      { cognito_sub: `service:autopilot:${B}`, email: `autopilot@${carrierB.slug}.invalid`, role: "staff" },
      { cognito_sub: `service:sweep:${B}`, email: `sweep@${carrierB.slug}.invalid`, role: "staff" },
      { cognito_sub: `sub-${B}`, email: carrierB.email, role: "admin" },
    ]);
  });

  it("reruns both carriers and changes nothing", async () => {
    const before = [await rowsOf(A), await rowsOf(B)];
    await ensureRows(master, carrierA, A, adminOf(carrierA, `sub-${A}`));
    await ensureRows(master, carrierB, B, adminOf(carrierB, `sub-${B}`));
    expect([await rowsOf(A), await rowsOf(B)]).toEqual(before);
  });

  it("adds the clerk (staff) and the demo visitor (judge) to the first carrier with their own roles", async () => {
    const before = await rowsOf(B);
    const clerk: DemoMember = { sub: `clerk-${A}`, email: `clerk@a-${tag}.example`, role: "staff" };
    const judge: DemoMember = { sub: `judge-${A}`, email: `judge@a-${tag}.example`, role: "judge" };
    await ensureRows(master, carrierA, A, clerk);
    await ensureRows(master, carrierA, A, judge);
    // A rerun changes nothing.
    await ensureRows(master, carrierA, A, judge);
    const a = await rowsOf(A);
    expect(a.members).toMatchObject([
      { cognito_sub: clerk.sub, email: clerk.email, role: "staff" },
      { cognito_sub: judge.sub, email: judge.email, role: "judge" },
      { cognito_sub: `service:autopilot:${A}`, role: "staff" },
      { cognito_sub: `service:sweep:${A}`, role: "staff" },
      { cognito_sub: `sub-${A}`, email: carrierA.email, role: "admin" },
    ]);
    expect(await rowsOf(B)).toEqual(before);
  });

  it("never changes a login's role: the demo visitor asked for as staff is refused", async () => {
    const before = await rowsOf(A);
    const promoted: DemoMember = { sub: `judge-${A}`, email: `judge@a-${tag}.example`, role: "staff" };
    await expect(ensureRows(master, carrierA, A, promoted)).rejects.toThrow(/already holds another role/);
    expect(await rowsOf(A)).toEqual(before);
  });

  it("refuses a slug that belongs to another carrier and keeps nothing", async () => {
    const C = randomUUID();
    made.add(C);
    const before = await rowsOf(A);
    const taken = { ...carrier("c", "America/Denver"), slug: carrierA.slug };
    // The tenant insert skips the taken slug, and the read-back stops it before the membership.
    await expect(ensureRows(master, taken, C, adminOf(taken, `sub-${C}`))).rejects.toThrow(
      /belongs to another tenant id/,
    );
    expect(await rowsOf(C)).toEqual({ tenants: [], members: [], rules: [] });
    expect(await rowsOf(A)).toEqual(before);
  });

  it("refuses a login linked to another carrier and keeps nothing", async () => {
    const D = randomUUID();
    made.add(D);
    const before = await rowsOf(A);
    // Same login and email as carrier A, so only the tenant filter tells them apart.
    const other = { ...carrier("d", "America/Denver"), email: carrierA.email };
    await expect(ensureRows(master, other, D, adminOf(other, `sub-${A}`))).rejects.toThrow(
      /linked to another tenant/,
    );
    expect(await rowsOf(D)).toEqual({ tenants: [], members: [], rules: [] });
    expect(await rowsOf(A)).toEqual(before);
  });
});
