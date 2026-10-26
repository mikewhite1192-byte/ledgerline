import { countTenantRows, readTenant } from "../data/read";
import { TENANT_TABLES, type TenantTable } from "../data/tables";
import { deleteTenantRows, insertTenantRows } from "../data/writer";
import type { Db, Queryable, TenantDb } from "../db/types";
import { isUuid } from "../uuid";
import type { DemoCarrier } from "./carriers";
import type { CarrierPlan } from "./plan";
import { countRows } from "./summary";

// Writing a plan (design 4.6). Replace is the only mode: in one tenant transaction, delete every
// row of the seventeen tables for that tenant, insert the plan, read the counts back, and roll
// back on any difference. The seed never creates tenants or memberships.
//
// Two logins. The admin looks the tenant up by slug (one SELECT on tenants) and clears its money
// ledger rows, which the app role cannot delete. Every data write runs as the app role inside
// withTenant, so row-level security bounds it too, and every statement still names its tenant,
// so the writes stay on one tenant even under a login that bypasses row-level security.

export type SeedReport = {
  deleted: Record<TenantTable, number>;
  inserted: Record<TenantTable, number>;
};

// The demo tenant's id. Its name and time zone must equal the constants, or this is the wrong
// database and nothing is written.
export async function findDemoTenant(admin: Db, carrier: DemoCarrier): Promise<string> {
  const rows = await admin.withoutTenant((q) =>
    q.query<{ id: string; name: string; timezone: string }>(
      "SELECT id, name, timezone FROM tenants WHERE slug = $1",
      [carrier.slug],
    ),
  );
  if (rows.length !== 1) throw new Error(`no tenant ${carrier.slug}: run npm run demo:users first`);
  const [t] = rows;
  if (!isUuid(t.id) || t.name !== carrier.name || t.timezone !== carrier.timezone) {
    throw new Error(`tenant ${carrier.slug} does not match the demo carrier`);
  }
  return t.id;
}

// A replace re-creates every subject with the same id, so the tenant's old ledger rows (keyed
// kind:subject:attempt) would replay their old outcome, or block the subject for good, against
// the new rows. The app role has no DELETE on money_actions, so the admin login removes them. That
// login ignores row-level security, so the statement names the tenant itself, as a bound
// parameter. Returns the rows deleted.
export async function clearTenantLedger(admin: Db, tenantId: string): Promise<number> {
  return admin.withTenant(tenantId, (q) =>
    q.execute("DELETE FROM money_actions WHERE tenant_id = CAST($1 AS uuid)", [tenantId]),
  );
}

// Inside the tenant transaction: the current tenant is the carrier the plan was built for.
export async function verifyTenant(q: Queryable, carrier: DemoCarrier): Promise<void> {
  const tenant = await readTenant(q);
  if (
    !tenant ||
    tenant.slug !== carrier.slug ||
    tenant.name !== carrier.name ||
    tenant.timezone !== carrier.timezone
  ) {
    throw new Error(`the current tenant is not ${carrier.slug}`);
  }
}

export async function replaceTenantData(
  app: TenantDb,
  tenantId: string,
  plan: CarrierPlan,
): Promise<SeedReport> {
  return app.withTenant(tenantId, async (q) => {
    await verifyTenant(q, plan.carrier);
    const deleted = await deleteTenantRows(q);
    const inserted = await insertTenantRows(q, plan.rows);
    const counts = await countTenantRows(q);
    const expected = countRows(plan.rows);
    for (const table of TENANT_TABLES) {
      if (inserted[table] !== expected[table] || counts[table] !== expected[table]) {
        throw new Error(`${table}: the rows read back differ from the plan`);
      }
    }
    return { deleted, inserted };
  });
}
