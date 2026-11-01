import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import { readDriverIdentity } from "../advances/identity";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { addJudge, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { ForbiddenError } from "../tenant/context";
import { createDriver } from "./create";

// Adding a driver as the app role sees it: only an admin, only in their own carrier under row level
// security, one row with the money switch off and nothing else beside it, the same driver sent twice
// (or at once) written once, a code or email already on file answered by its category, and nothing
// written while driver admin is off. Every tenant made here is removed after each test.

// 04:00 UTC on Nov 2 is still Nov 1 in the fixture carrier's zone (America/Chicago).
const NOW = Date.UTC(2026, 10, 2, 4, 0, 0);
const clock = () => new Date(NOW);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;

const deps = () => ({ db: app, clock });
const saved = flags.driverAdmin.enabled;

const BODY = {
  code: "BR-D27",
  firstName: "Ana",
  lastName: "Example",
  email: "ana.example@example.test",
  workerType: "owner_operator",
  payBasis: "percent",
  percentBps: 7_250,
};

const makeAdmin = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
      f.memberId,
    ]),
  );

type Row = Record<string, unknown>;

// Every driver in f's carrier, read as the app role in `as`'s tenant.
const driversOf = (f: Fixture, as: Fixture = f) =>
  app.withTenant(as.tenantId, (q) =>
    q.query<Row>(
      `SELECT CAST(id AS text) AS id, code, first_name, last_name, email, worker_type, pay_basis, per_mile_cents,
              percent_bps, flat_per_load_cents, advance_limit_cents, escrow_balance_cents, truck_unit, tank_gallons,
              to_char(active_from, 'YYYY-MM-DD') AS active_from, active_to, preferred_language, own_insurance,
              money_armed, money_armed_at
         FROM drivers WHERE tenant_id = CAST($1 AS uuid) ORDER BY code`,
      [f.tenantId],
    ),
  );

const countFor = (f: Fixture, table: string, driverId: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const rows = await q.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)`,
      [driverId],
    );
    return Number(rows[0].n);
  });

beforeAll(() => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
});

beforeEach(async () => {
  flags.driverAdmin.enabled = true;
  const tag = randomUUID().slice(0, 8);
  A = await makeTenant(admin, `add-driver-a-${tag}`);
  B = await makeTenant(admin, `add-driver-b-${tag}`);
});

afterEach(async () => {
  flags.driverAdmin.enabled = saved;
  await dropTenant(admin, A);
  await dropTenant(admin, B);
});

afterAll(async () => {
  await app?.close();
  await admin?.close();
});

describe("adding a driver", () => {
  it("writes one row in the admin's carrier, not armed, with no card, id, arm log or escrow", async () => {
    await makeAdmin(A);
    const out = await createDriver(A.session, BODY, deps());
    expect(out).toMatchObject({ ok: true, changed: true });
    const id = out.ok ? out.id : "";
    const rows = (await driversOf(A)).filter((r) => r.code === "BR-D27");
    expect(rows).toEqual([
      {
        id,
        code: "BR-D27",
        first_name: "Ana",
        last_name: "Example",
        email: "ana.example@example.test",
        worker_type: "owner_operator",
        pay_basis: "percent",
        per_mile_cents: null,
        percent_bps: 7_250,
        flat_per_load_cents: null,
        advance_limit_cents: null,
        escrow_balance_cents: 0,
        truck_unit: null,
        tank_gallons: 200,
        // No start date sent: today in the carrier's zone, not the UTC date.
        active_from: "2026-11-01",
        active_to: null,
        preferred_language: "en",
        own_insurance: false,
        money_armed: false,
        money_armed_at: null,
      },
    ]);
    for (const table of ["driver_cards", "driver_identities", "driver_arm_events"]) {
      expect(await countFor(A, table, id), table).toBe(0);
    }
    // The money panel reads them as not armed with no card.
    const identity = await app.withTenant(A.tenantId, (q) => readDriverIdentity(q, id));
    expect(identity).toMatchObject({ driverId: id, code: "BR-D27", armed: { on: false, since: null }, cards: [] });
    // Another carrier sees none of it.
    const seenByB = await app.withTenant(B.tenantId, (q) =>
      q.query("SELECT id FROM drivers WHERE id = CAST($1 AS uuid)", [id]),
    );
    expect(seenByB).toEqual([]);
    expect((await driversOf(B)).map((r) => r.code)).toEqual(["DRV-1", "DRV-2"]);
  });

  it("keeps every optional field it is sent", async () => {
    await makeAdmin(A);
    const out = await createDriver(
      A.session,
      {
        code: " br-d28 ",
        firstName: "Ben",
        lastName: "Example",
        email: "Ben.Example@Example.TEST",
        workerType: "company",
        payBasis: "flat",
        flatPerLoadCents: 45_000,
        advanceLimitCents: 0,
        truckUnit: "br-t128",
        tankGallons: 150,
        activeFrom: "2026-11-09",
        ownInsurance: true,
        preferredLanguage: "es",
      },
      deps(),
    );
    expect(out).toMatchObject({ ok: true });
    expect((await driversOf(A)).find((r) => r.code === "BR-D28")).toMatchObject({
      email: "ben.example@example.test",
      pay_basis: "flat",
      flat_per_load_cents: 45_000,
      percent_bps: null,
      advance_limit_cents: 0,
      truck_unit: "BR-T128",
      tank_gallons: 150,
      active_from: "2026-11-09",
      own_insurance: true,
      preferred_language: "es",
      money_armed: false,
    });
  });

  it("writes the same driver once, sent again or sent twice at once, and answers code_taken", async () => {
    await makeAdmin(A);
    expect(await createDriver(A.session, BODY, deps())).toMatchObject({ ok: true });
    expect(await createDriver(A.session, BODY, deps())).toEqual({ ok: false, category: "code_taken", retryable: false });
    const both = await Promise.all([
      createDriver(A.session, { ...BODY, code: "BR-D29", email: "cal@example.test" }, deps()),
      createDriver(A.session, { ...BODY, code: "BR-D29", email: "cal@example.test" }, deps()),
    ]);
    expect(both.map((r) => (r.ok ? "ok" : r.category)).sort()).toEqual(["code_taken", "ok"]);
    expect((await driversOf(A)).map((r) => r.code)).toEqual(["BR-D27", "BR-D29", "DRV-1", "DRV-2"]);
  });

  it("answers a code or an email already on file, in any case, by its category and writes nothing", async () => {
    await makeAdmin(A);
    // The fixture's drivers are DRV-1 and DRV-2, emailed drv-1@<slug>.example.
    const fixtureEmail = (await driversOf(A)).find((r) => r.code === "DRV-1")?.email as string;
    expect(await createDriver(A.session, { ...BODY, code: "drv-1" }, deps())).toMatchObject({ category: "code_taken" });
    expect(await createDriver(A.session, { ...BODY, email: fixtureEmail.toUpperCase() }, deps())).toMatchObject({
      category: "email_taken",
    });
    expect((await driversOf(A)).map((r) => r.code)).toEqual(["DRV-1", "DRV-2"]);
    // The same code and email in another carrier is that carrier's own driver.
    await makeAdmin(B);
    expect(await createDriver(B.session, { ...BODY, code: "DRV-1", email: fixtureEmail }, deps())).toEqual({
      ok: false,
      category: "code_taken",
      retryable: false,
    });
    expect(await createDriver(B.session, { ...BODY, email: fixtureEmail }, deps())).toMatchObject({ ok: true });
  });

  it("lets only an admin add one: staff are refused by role and a judge is refused outright", async () => {
    expect(await createDriver(A.session, BODY, deps())).toEqual({ ok: false, category: "role", retryable: false });
    const judge = await addJudge(admin, A);
    await expect(createDriver(judge, BODY, deps())).rejects.toBeInstanceOf(ForbiddenError);
    // A login of one carrier naming another carrier's tenant is no member there.
    await makeAdmin(A);
    await expect(createDriver({ ...A.session, tenantId: B.tenantId }, BODY, deps())).rejects.toBeInstanceOf(ForbiddenError);
    expect((await driversOf(A)).map((r) => r.code)).toEqual(["DRV-1", "DRV-2"]);
    expect((await driversOf(B)).map((r) => r.code)).toEqual(["DRV-1", "DRV-2"]);
  });

  it("writes nothing while driver admin is off, for an admin too", async () => {
    await makeAdmin(A);
    flags.driverAdmin.enabled = false;
    expect(await createDriver(A.session, BODY, deps())).toEqual({ ok: false, category: "disabled", retryable: false });
    expect((await driversOf(A)).map((r) => r.code)).toEqual(["DRV-1", "DRV-2"]);
  });

  it("leaves the table's own checks in place for a row built by hand", async () => {
    // A percent driver with a per-mile rate: the pairing CHECK refuses it.
    expect(
      await sqlStateOf(
        app.withTenant(A.tenantId, (q) =>
          q.execute(
            `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
               per_mile_cents, active_from)
             VALUES (CAST($1 AS uuid), current_tenant_id(), 'BR-D30', 'A', 'B', 'ab@example.test', 'company',
               'percent', 60, CAST('2026-11-01' AS date))`,
            [randomUUID()],
          ),
        ),
      ),
    ).toBe("23514");
    // A row naming another carrier is refused by the tenant policy.
    expect(
      await sqlStateOf(
        app.withTenant(A.tenantId, (q) =>
          q.execute(
            `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
               per_mile_cents, active_from)
             VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'BR-D31', 'A', 'B', 'ab@example.test', 'company',
               'per_mile', 60, CAST('2026-11-01' AS date))`,
            [randomUUID(), B.tenantId],
          ),
        ),
      ),
    ).toBe("42501");
  });
});
