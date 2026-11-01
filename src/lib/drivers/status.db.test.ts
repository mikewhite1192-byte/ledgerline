import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import { readDriverIdentity } from "../advances/identity";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param, Queryable, TenantDb } from "../db/types";
import { addJudge, dropTenant, makeTenant, setArmed, sqlStateOf, type Fixture } from "../money/test-db";
import { ForbiddenError } from "../tenant/context";
import { addDays } from "../time/local-date";
import { readDriverMoneyState } from "./active";
import { setDriverStatus, STATUS_DATE_MAX_DAYS } from "./status";

// Deactivating and reactivating a driver as the app role sees it (0081): only an admin, only in
// their own carrier under row level security; a deactivation writes the last day, disarms an
// armed driver with one arming log row and records one status event, all in one transaction; a
// reactivation clears the last day, never arms, and records one event; the same change sent
// again writes nothing; a last day before the start or more than a year from today is refused;
// nothing is written while driver admin is off. The status log is append-only for the app role
// and another carrier sees none of it. Every tenant made here is removed after each test.

// 04:00 UTC on Nov 2 is still Nov 1 in the fixture carrier's zone (America/Chicago).
const NOW = Date.UTC(2026, 10, 2, 4, 0, 0);
const TODAY = "2026-11-01";
const clock = () => new Date(NOW);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;

const deps = (db: TenantDb = app) => ({ db, clock });
const saved = flags.driverAdmin.enabled;

const makeAdmin = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
      f.memberId,
    ]),
  );

type DriverState = { active_to: string | null; money_armed: boolean; money_armed_at: string | null };

const driverState = async (f: Fixture, driverId = f.driverId): Promise<DriverState> =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<DriverState>(
        `SELECT to_char(active_to, 'YYYY-MM-DD') AS active_to, money_armed,
                to_char(money_armed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS money_armed_at
           FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [driverId],
      ),
    )
  )[0];

const statusEvents = (f: Fixture, driverId = f.driverId) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<Record<string, unknown>>(
      `SELECT active, to_char(effective_on, 'YYYY-MM-DD') AS effective_on, note, CAST(membership_id AS text) AS membership_id
         FROM driver_status_events WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)
        ORDER BY created_at, active`,
      [driverId],
    ),
  );

const armEvents = (f: Fixture, driverId = f.driverId) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<Record<string, unknown>>(
      `SELECT armed, note, source, CAST(membership_id AS text) AS membership_id
         FROM driver_arm_events WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)
        ORDER BY created_at`,
      [driverId],
    ),
  );

// Whether anything about the driver changed: their row, their status log and their arming log.
const snapshot = async (f: Fixture, driverId = f.driverId) => ({
  driver: await driverState(f, driverId),
  status: await statusEvents(f, driverId),
  arms: await armEvents(f, driverId),
});

// A database whose queries fail on the status log insert: stands in for a write that fails after
// the driver row and the arming log were already changed in the same transaction.
function failingOnStatusInsert(db: TenantDb): TenantDb {
  return {
    withTenant: (tenantId, fn) =>
      db.withTenant(tenantId, (q) => {
        const wrapped: Queryable = {
          query: <T,>(sql: string, params?: Param[]) => q.query<T>(sql, params),
          execute: (sql: string, params?: Param[]) => {
            if (sql.includes("INSERT INTO driver_status_events")) throw new Error("status insert failed");
            return q.execute(sql, params);
          },
        };
        return fn(wrapped);
      }),
  };
}

beforeAll(() => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
});

beforeEach(async () => {
  flags.driverAdmin.enabled = true;
  const tag = randomUUID().slice(0, 8);
  A = await makeTenant(admin, `driver-status-a-${tag}`);
  B = await makeTenant(admin, `driver-status-b-${tag}`);
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

describe("deactivating and reactivating a driver", () => {
  it("deactivates on today in the carrier's zone, disarms in the same transaction and logs both changes once", async () => {
    await makeAdmin(A);
    const before = await driverState(A);
    expect(await setDriverStatus(A.session, A.driverId, { active: false, note: "moved to another carrier" }, deps())).toEqual({
      ok: true,
      changed: true,
      active: true,
      activeTo: TODAY,
      armed: false,
    });
    // The last armed time stays as history, as a disarm from the money panel keeps it.
    expect(await driverState(A)).toEqual({ active_to: TODAY, money_armed: false, money_armed_at: before.money_armed_at });
    expect(await armEvents(A)).toEqual([{ armed: false, note: "deactivated", source: "ui", membership_id: A.memberId }]);
    expect(await statusEvents(A)).toEqual([
      { active: false, effective_on: TODAY, note: "moved to another carrier", membership_id: A.memberId },
    ]);
    // The other driver is untouched.
    expect(await driverState(A, A.otherDriverId)).toMatchObject({ active_to: null, money_armed: true });
    // The money panel reads the last day.
    const identity = await app.withTenant(A.tenantId, (q) => readDriverIdentity(q, A.driverId));
    expect(identity).toMatchObject({ activeTo: TODAY, armed: { on: false } });
  });

  it("answers the same deactivation again as no change and writes nothing (the driver lock and the transition)", async () => {
    await makeAdmin(A);
    await setDriverStatus(A.session, A.driverId, { active: false, effectiveOn: "2026-10-31" }, deps());
    const after = await snapshot(A);
    expect(await setDriverStatus(A.session, A.driverId, { active: false }, deps())).toEqual({
      ok: true,
      changed: false,
      active: false,
      activeTo: "2026-10-31",
      armed: false,
    });
    expect(await setDriverStatus(A.session, A.driverId, { active: false, effectiveOn: "2026-10-20" }, deps())).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(await snapshot(A)).toEqual(after);
  });

  it("writes one change when the same deactivation is sent twice at once", async () => {
    await makeAdmin(A);
    const outs = await Promise.all([
      setDriverStatus(A.session, A.driverId, { active: false }, deps()),
      setDriverStatus(A.session, A.driverId, { active: false }, deps()),
    ]);
    expect(outs.map((o) => (o.ok ? o.changed : o.category)).sort()).toEqual([false, true]);
    expect(await statusEvents(A)).toHaveLength(1);
    expect(await armEvents(A)).toHaveLength(1);
  });

  it("reactivates without arming, logs one event naming the day cleared, and a second reactivation is no change", async () => {
    await makeAdmin(A);
    await setDriverStatus(A.session, A.driverId, { active: false, effectiveOn: "2026-10-31" }, deps());
    expect(await setDriverStatus(A.session, A.driverId, { active: true, note: "back" }, deps())).toEqual({
      ok: true,
      changed: true,
      active: true,
      activeTo: null,
      armed: false,
    });
    expect(await driverState(A)).toMatchObject({ active_to: null, money_armed: false });
    expect(await statusEvents(A)).toEqual([
      { active: false, effective_on: "2026-10-31", note: null, membership_id: A.memberId },
      { active: true, effective_on: "2026-10-31", note: "back", membership_id: A.memberId },
    ]);
    // Only the deactivation's disarm is on the arming log: reactivating never arms.
    expect(await armEvents(A)).toEqual([{ armed: false, note: "deactivated", source: "ui", membership_id: A.memberId }]);
    const after = await snapshot(A);
    expect(await setDriverStatus(A.session, A.driverId, { active: true }, deps())).toMatchObject({ ok: true, changed: false });
    expect(await snapshot(A)).toEqual(after);
    // The money gates read the driver as active and not armed.
    const state = await app.withTenant(A.tenantId, (q) => readDriverMoneyState(q, A.driverId, TODAY, false));
    expect(state).toBe("not_armed");
  });

  it("deactivates a driver who is not armed with no arming log row", async () => {
    await makeAdmin(A);
    await setArmed(admin, A, A.driverId, false);
    expect(await setDriverStatus(A.session, A.driverId, { active: false }, deps())).toMatchObject({ ok: true, changed: true });
    expect(await armEvents(A)).toEqual([]);
    expect(await statusEvents(A)).toHaveLength(1);
  });

  it("rolls the last day and the disarm back when the status log cannot be written", async () => {
    await makeAdmin(A);
    const before = await snapshot(A);
    await expect(
      setDriverStatus(A.session, A.driverId, { active: false }, deps(failingOnStatusInsert(app))),
    ).rejects.toThrow("status insert failed");
    expect(await snapshot(A)).toEqual(before);
    expect(before.driver).toMatchObject({ active_to: null, money_armed: true });
  });

  it("refuses a last day before the start or more than a year from today, and writes nothing", async () => {
    await makeAdmin(A);
    const before = await snapshot(A);
    for (const effectiveOn of ["2025-12-31", addDays(TODAY, STATUS_DATE_MAX_DAYS + 1)]) {
      expect(await setDriverStatus(A.session, A.driverId, { active: false, effectiveOn }, deps()), effectiveOn).toEqual({
        ok: false,
        category: "bad_request",
        retryable: false,
      });
    }
    // Moved the start back so only the one-year bound applies.
    await admin.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE drivers SET active_from = DATE '2024-01-01' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        A.driverId,
      ]),
    );
    expect(
      await setDriverStatus(A.session, A.driverId, { active: false, effectiveOn: addDays(TODAY, -(STATUS_DATE_MAX_DAYS + 1)) }, deps()),
    ).toMatchObject({ ok: false, category: "bad_request" });
    expect(await snapshot(A)).toEqual(before);
    // The bound itself is allowed, on the start date too.
    expect(
      await setDriverStatus(A.session, A.driverId, { active: false, effectiveOn: addDays(TODAY, STATUS_DATE_MAX_DAYS) }, deps()),
    ).toMatchObject({ ok: true, changed: true, activeTo: addDays(TODAY, STATUS_DATE_MAX_DAYS) });
  });

  it("writes nothing while driver admin is off, for a staff member, or for a demo visitor", async () => {
    const before = await snapshot(A);
    expect(await setDriverStatus(A.session, A.driverId, { active: false }, deps())).toMatchObject({ ok: false, category: "role" });
    await makeAdmin(A);
    flags.driverAdmin.enabled = false;
    expect(await setDriverStatus(A.session, A.driverId, { active: false }, deps())).toMatchObject({
      ok: false,
      category: "disabled",
    });
    flags.driverAdmin.enabled = true;
    const judge = await addJudge(admin, A);
    await expect(setDriverStatus(judge, A.driverId, { active: false }, deps())).rejects.toBeInstanceOf(ForbiddenError);
    expect(await snapshot(A)).toEqual(before);
  });

  it("finds no driver of another carrier, and another carrier sees none of the log", async () => {
    await makeAdmin(A);
    await makeAdmin(B);
    expect(await setDriverStatus(B.session, A.driverId, { active: false }, deps())).toEqual({
      ok: false,
      category: "not_found",
      retryable: false,
    });
    expect(await driverState(A)).toMatchObject({ active_to: null, money_armed: true });
    await setDriverStatus(A.session, A.driverId, { active: false }, deps());
    const seenByB = await app.withTenant(B.tenantId, (q) => q.query("SELECT id FROM driver_status_events"));
    expect(seenByB).toEqual([]);
    const seenByA = await app.withTenant(A.tenantId, (q) => q.query("SELECT id FROM driver_status_events"));
    expect(seenByA).toHaveLength(1);
  });
});

describe("migration 0081: the status log", () => {
  const insertAs = (q: Queryable, tenantId: string, driverId: string, memberId: string, note: string | null = null) =>
    q.execute(
      `INSERT INTO driver_status_events (id, tenant_id, driver_id, active, effective_on, note, membership_id)
       VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), false, DATE '2026-11-01', $4, CAST($5 AS uuid))`,
      [randomUUID(), tenantId, driverId, note, memberId],
    );

  it("is append-only for the app role: no update and no delete", async () => {
    await app.withTenant(A.tenantId, (q) => insertAs(q, A.tenantId, A.driverId, A.memberId));
    expect(
      await sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute("UPDATE driver_status_events SET note = 'changed'"))),
    ).toBe("42501");
    expect(await sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute("DELETE FROM driver_status_events")))).toBe("42501");
    expect(await statusEvents(A)).toHaveLength(1);
  });

  it("refuses a row for another carrier, naming another carrier's driver or member, and a bad note", async () => {
    // Row level security: the app role cannot write another tenant's row.
    expect(await sqlStateOf(app.withTenant(A.tenantId, (q) => insertAs(q, B.tenantId, B.driverId, B.memberId)))).toBe("42501");
    // Every reference carries tenant_id, so another carrier's driver or member is not found.
    expect(await sqlStateOf(app.withTenant(A.tenantId, (q) => insertAs(q, A.tenantId, B.driverId, A.memberId)))).toBe("23503");
    expect(await sqlStateOf(app.withTenant(A.tenantId, (q) => insertAs(q, A.tenantId, A.driverId, B.memberId)))).toBe("23503");
    expect(await sqlStateOf(app.withTenant(A.tenantId, (q) => insertAs(q, A.tenantId, A.driverId, A.memberId, "")))).toBe("23514");
    expect(
      await sqlStateOf(app.withTenant(A.tenantId, (q) => insertAs(q, A.tenantId, A.driverId, A.memberId, "x".repeat(241)))),
    ).toBe("23514");
    expect(await statusEvents(A)).toEqual([]);
    expect(await statusEvents(B, B.driverId)).toEqual([]);
  });

  it("forces row level security on the table, and its rows go with their driver", async () => {
    const [rls] = await admin.withoutTenant((q) =>
      q.query<{ enabled: boolean; forced: boolean }>(
        "SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE relname = 'driver_status_events'",
      ),
    );
    expect(rls).toEqual({ enabled: true, forced: true });
    await app.withTenant(A.tenantId, (q) => insertAs(q, A.tenantId, A.otherDriverId, A.memberId));
    await admin.withTenant(A.tenantId, async (q) => {
      await q.execute("DELETE FROM driver_cards WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)", [A.otherDriverId]);
      await q.execute("DELETE FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [A.otherDriverId]);
    });
    expect(await statusEvents(A, A.otherDriverId)).toEqual([]);
  });
});
