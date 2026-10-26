import type { Db } from "../../src/lib/db/types";

export type DemoCarrier = { slug: string; name: string; timezone: string; email: string };

// The tenant row and the membership for one demo carrier, written as that tenant and read back
// whole. A slug or a login already tied to another tenant fails here.
//
// Every statement names its tenant itself (current_tenant_id() in the values and the WHERE),
// because row-level security does not hold the login that runs this. On Aurora the admin is the
// cluster's master user, in rds_superuser, and it reads every carrier's rows even with FORCE on
// and app.tenant_id set; locally the admin is a superuser. Only payday_app is held by the
// policies. See db/README.md.
export async function ensureRows(db: Db, carrier: DemoCarrier, tenantId: string, sub: string) {
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
       VALUES (current_tenant_id(), $1, $2, 'admin') ON CONFLICT (cognito_sub) DO NOTHING`,
      [sub, carrier.email],
    );
    const member = await q.query<{ email: string }>(
      "SELECT email FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
      [sub],
    );
    if (member.length !== 1 || member[0].email !== carrier.email) {
      throw new Error(`${carrier.email} is linked to another tenant; fix it by hand`);
    }
  });
}
