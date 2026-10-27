import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb } from "../../db/pg";
import { adminUrl, appUrl } from "../../db/test-urls";
import type { Db } from "../../db/types";
import { dropTenant, makeTenant, type Fixture } from "../../money/test-db";
import { dbTmsAdapter } from "./db";

// The invoice read against the real tables, as the app role: one load with its state miles,
// accessorials and customer, mapped through the same record functions the seed reads use, and
// nothing for another tenant's load.

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
const loadId = randomUUID();

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
  const tag = randomUUID().slice(0, 8);
  A = await makeTenant(admin, `tms-a-${tag}`);
  B = await makeTenant(admin, `tms-b-${tag}`);
  await admin.withTenant(A.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
         origin_state, dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles,
         empty_miles, linehaul_cents, fuel_surcharge_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'L-100', CAST($2 AS uuid), CAST($3 AS uuid),
         'delivered', 'Joliet', 'IL', 'Gary', 'IN', CAST('2026-11-02' AS date),
         CAST('2026-11-03' AS date), CAST('2026-11-03T18:30:00Z' AS timestamptz), 410, 25,
         123456, 7890)`,
      [loadId, A.customerId, A.driverId],
    );
    for (const [state, miles] of [
      ["IN", 60],
      ["IL", 350],
    ] as const) {
      await q.execute(
        `INSERT INTO load_state_miles (id, tenant_id, load_id, state, miles)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4)`,
        [randomUUID(), loadId, state, miles],
      );
    }
    await q.execute(
      `INSERT INTO load_accessorials (id, tenant_id, load_id, kind, seq, amount_cents, description)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'detention', 1, 5000,
         'Two hours at the shipper')`,
      [randomUUID(), loadId],
    );
  });
});

afterAll(async () => {
  await dropTenant(admin, A);
  await dropTenant(admin, B);
  await app?.close();
  await admin?.close();
});

describe("dbTmsAdapter.invoiceSource", () => {
  it("reads the load with its miles, accessorials and customer", async () => {
    const out = await app.withTenant(A.tenantId, (q) => dbTmsAdapter.invoiceSource(q, loadId));
    expect(out).not.toBeNull();
    expect(out?.load).toMatchObject({
      id: loadId,
      loadNumber: "L-100",
      customerId: A.customerId,
      driverId: A.driverId,
      status: "delivered",
      originState: "IL",
      destState: "IN",
      pickupOn: "2026-11-02",
      deliveredOn: "2026-11-03",
      loadedMiles: 410,
      emptyMiles: 25,
      linehaulCents: 123_456,
      fuelSurchargeCents: 7_890,
    });
    expect(out?.load.stateMiles.map((m) => [m.state, m.miles]).sort()).toEqual([
      ["IL", 350],
      ["IN", 60],
    ]);
    expect(out?.load.accessorials).toHaveLength(1);
    expect(out?.load.accessorials[0]).toMatchObject({ kind: "detention", amountCents: 5_000 });
    expect(out?.customer).toMatchObject({ id: A.customerId, code: "CUST-1", termsDays: 30 });
  });

  it("finds nothing for another tenant's load or a load that does not exist", async () => {
    expect(await app.withTenant(B.tenantId, (q) => dbTmsAdapter.invoiceSource(q, loadId))).toBeNull();
    expect(
      await app.withTenant(A.tenantId, (q) => dbTmsAdapter.invoiceSource(q, randomUUID())),
    ).toBeNull();
    // The admin login skips row-level security; the read still names its tenant.
    expect(await admin.withTenant(B.tenantId, (q) => dbTmsAdapter.invoiceSource(q, loadId))).toBeNull();
  });

  it("refuses an id that is not a uuid before any SQL", async () => {
    await expect(
      app.withTenant(A.tenantId, (q) => dbTmsAdapter.invoiceSource(q, "L-100")),
    ).rejects.toThrow("loadId is not a uuid");
  });
});
