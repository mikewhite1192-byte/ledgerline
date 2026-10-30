import type { Db } from "../../src/lib/db/types";
import type { Role } from "../../src/lib/roles";

export type DemoCarrier = { slug: string; name: string; timezone: string; email: string };
export type DemoMember = { sub: string; email: string; role: Role };

// The tenant row and one login's membership for a demo carrier, written as that tenant and read
// back whole. A slug or a login already tied to another tenant, or a login that already holds
// another role, fails here: a rerun never changes a role (a judge must never become staff).
//
// Every statement names its tenant itself (current_tenant_id() in the values and the WHERE),
// because row-level security does not hold the login that runs this. On Aurora the admin is the
// cluster's master user, in rds_superuser, and it reads every carrier's rows even with FORCE on
// and app.tenant_id set; locally the admin is a superuser. Only payday_app is held by the
// policies. See db/README.md.
export async function ensureRows(db: Db, carrier: DemoCarrier, tenantId: string, member: DemoMember) {
  await db.withTenant(tenantId, async (q) => {
    const zone = await q.query("SELECT 1 AS ok FROM pg_timezone_names WHERE name = $1", [
      carrier.timezone,
    ]);
    if (zone.length !== 1) throw new Error(`${carrier.timezone} is not a time zone name`);
    await q.execute(
      `INSERT INTO tenants (id, slug, name, timezone)
       VALUES (current_tenant_id(), $1, $2, $3) ON CONFLICT (slug) DO NOTHING`,
      [carrier.slug, carrier.name, carrier.timezone],
    );
    const tenant = await q.query<{ slug: string }>(
      "SELECT slug FROM tenants WHERE id = current_tenant_id()",
    );
    if (tenant.length !== 1 || tenant[0].slug !== carrier.slug) {
      throw new Error(`${carrier.slug} belongs to another tenant id; fix it by hand`);
    }
    await q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), $1, $2, $3) ON CONFLICT (cognito_sub) DO NOTHING`,
      [member.sub, member.email, member.role],
    );
    const found = await q.query<{ email: string; role: string }>(
      "SELECT email, role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
      [member.sub],
    );
    if (found.length !== 1 || found[0].email !== member.email) {
      throw new Error(`${member.email} is linked to another tenant; fix it by hand`);
    }
    if (found[0].role !== member.role) {
      throw new Error(`${member.email} already holds another role; fix it by hand`);
    }
    // The pay sweep's own login for this carrier (migration 0018 adds it for tenants that
    // already exist): staff, and its sub is not a Cognito id, so no person can sign in as it.
    await q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text),
               'sweep@' || $1 || '.invalid', 'staff')
       ON CONFLICT (cognito_sub) DO NOTHING`,
      [carrier.slug],
    );
  });
}
