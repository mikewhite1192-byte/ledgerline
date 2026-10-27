// Database test fixtures for the money ledger: a throwaway tenant with one membership, two
// drivers (each with an active fuel card that answers "ok"), a customer and a customer payment, all
// synthetic. Tests only; every tenant made here is removed by dropTenant (its rows go with it by
// cascade).

import { randomBytes, randomUUID } from "node:crypto";
import type { Session } from "../auth/claims";
import type { Db } from "../db/types";
import type { SimBehavior } from "./types";

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
      await q.execute(CARD_INSERT, cardValues(id, "ok"));
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

// A synthetic card: a random token of the provider's shape and random last four digits.
const CARD_INSERT = `INSERT INTO driver_cards (id, tenant_id, driver_id, provider, provider_token, last4,
     status, sim_behavior, source)
   VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'fuel_card_sim', $3, $4, 'active', $5, 'ui')`;

function cardValues(driverId: string, behavior: SimBehavior): [string, string, string, string, SimBehavior] {
  const last4 = String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0");
  return [randomUUID(), driverId, `fcs_card_${randomBytes(12).toString("hex")}`, last4, behavior];
}

// What the driver's active card answers when the simulated provider is called.
export async function setCardBehavior(admin: Db, f: Fixture, driverId: string, behavior: SimBehavior): Promise<void> {
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `UPDATE driver_cards SET sim_behavior = $2
        WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND status = 'active'`,
      [driverId, behavior],
    ),
  );
}

// Closes the driver's active card (it stays on file, closed).
export async function closeCard(admin: Db, f: Fixture, driverId: string): Promise<void> {
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `UPDATE driver_cards SET status = 'closed', closed_at = CAST('2026-11-02T16:30:00Z' AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND status = 'active'`,
      [driverId],
    ),
  );
}

// A new active card for the driver (after closeCard or removeCards); returns its id.
export async function addCard(admin: Db, f: Fixture, driverId: string, behavior: SimBehavior = "ok"): Promise<string> {
  const values = cardValues(driverId, behavior);
  await admin.withTenant(f.tenantId, (q) => q.execute(CARD_INSERT, values));
  return values[0];
}

// Every card the driver has, removed (an advance that named one keeps its row, card_id cleared).
export async function removeCards(admin: Db, f: Fixture, driverId: string): Promise<void> {
  await admin.withTenant(f.tenantId, (q) =>
    q.execute("DELETE FROM driver_cards WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)", [
      driverId,
    ]),
  );
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
