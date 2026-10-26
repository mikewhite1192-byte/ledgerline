// Database test fixtures for the money ledger: a throwaway tenant with one membership, two
// drivers, a customer and a customer payment, all synthetic. Tests only; every tenant made here is
// removed by dropTenant (its rows go with it by cascade).

import { randomUUID } from "node:crypto";
import type { Session } from "../auth/claims";
import type { Db } from "../db/types";

export type Fixture = {
  tenantId: string;
  memberId: string;
  session: Session;
  driverId: string;
  otherDriverId: string;
  customerId: string;
  paymentId: string;
};

export async function makeTenant(admin: Db, slug: string): Promise<Fixture> {
  const tenantId = randomUUID();
  const driverId = randomUUID();
  const otherDriverId = randomUUID();
  const customerId = randomUUID();
  const paymentId = randomUUID();
  const sub = `sub-${tenantId}`;
  const memberId = await admin.withTenant(tenantId, async (q) => {
    await q.execute(
      `INSERT INTO tenants (id, slug, name, timezone)
       VALUES (current_tenant_id(), $1, $2, 'America/Chicago')`,
      [slug, `Carrier ${slug}`],
    );
    await q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), $1, $2, 'staff')`,
      [sub, `ops@${slug}.example`],
    );
    for (const [id, code] of [
      [driverId, "DRV-1"],
      [otherDriverId, "DRV-2"],
    ]) {
      await q.execute(
        `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type,
           pay_basis, per_mile_cents, active_from)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $2, 'Test', 'Driver', $3, 'company',
           'per_mile', 60, CAST('2026-01-01' AS date))`,
        [id, code, `${code.toLowerCase()}@${slug}.example`],
      );
    }
    await q.execute(
      `INSERT INTO customers (id, tenant_id, code, name, terms_days, city, state)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'CUST-1', 'Test Shipper', 30, 'Springfield', 'IL')`,
      [customerId],
    );
    await q.execute(
      `INSERT INTO customer_payments (id, tenant_id, customer_id, received_on, amount_cents, method,
         payment_ref, source)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST('2026-11-02' AS date),
         50000, 'ach', 'ACH-1', 'ui')`,
      [paymentId, customerId],
    );
    const rows = await q.query<{ id: string }>(
      "SELECT CAST(id AS text) AS id FROM memberships WHERE tenant_id = current_tenant_id()",
    );
    return rows[0].id;
  });
  return {
    tenantId,
    memberId,
    session: { sub, email: "", tenantId },
    driverId,
    otherDriverId,
    customerId,
    paymentId,
  };
}

let refs = 0;

// A fresh advance for the fixture's first driver.
export async function addAdvance(
  admin: Db,
  f: Fixture,
  amountCents = 25_000,
  status: "requested" | "approved" = "requested",
): Promise<string> {
  const id = randomUUID();
  refs += 1;
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on,
         amount_cents, status, source)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3,
         CAST('2026-11-02T15:00:00Z' AS timestamptz), CAST('2026-11-02' AS date), $4, $5, 'ui')`,
      [id, f.driverId, `REQ-${refs}-${id.slice(0, 8)}`, amountCents, status],
    ),
  );
  return id;
}

// The ledger rows of one tenant, removed by the admin login (the app role has no DELETE).
export async function clearLedger(admin: Db, f: Fixture): Promise<void> {
  await admin.withTenant(f.tenantId, (q) =>
    q.execute("DELETE FROM money_actions WHERE tenant_id = current_tenant_id()"),
  );
}

export async function dropTenant(admin: Db, f: Fixture | undefined): Promise<void> {
  if (!f) return;
  await admin.withTenant(f.tenantId, (q) =>
    q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"),
  );
}

export async function sqlStateOf(work: Promise<unknown>): Promise<string | undefined> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (err === undefined) return "no error";
  return (err as { sqlState?: string }).sqlState ?? (err as { category?: string }).category;
}
