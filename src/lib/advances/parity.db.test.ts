import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { dropTenant, makeTenant, setArmed, sqlStateOf, type Fixture } from "../money/test-db";
import { armDriver } from "./arming";
import { readDefaultCard } from "./cards";
import { addCard, addIdentity, closeCard, readDriverIdentity, setDefaultCard } from "./identity";

// Migration 0027's driver tables and the services that write them, as the app role sees them:
// the tenant wall on the arm log, the identity map and the cards; the log that cannot be
// rewritten; only an admin arms a driver or changes a card (D-034), any member adds a dispatch
// id; one id is one driver's; one default card. Every tenant made here is removed after each test.

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const clock = () => new Date(NOW);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;

const deps = () => ({ db: app, clock });

const makeAdmin = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
      f.memberId,
    ]),
  );

const armEvents = (f: Fixture, as: Fixture = f) =>
  app.withTenant(as.tenantId, (q) =>
    q.query<{ driver_id: string; armed: boolean; note: string | null; membership_id: string | null; source: string }>(
      `SELECT CAST(driver_id AS text) AS driver_id, armed, note, CAST(membership_id AS text) AS membership_id, source
         FROM driver_arm_events WHERE tenant_id = CAST($1 AS uuid) ORDER BY created_at, id`,
      [f.tenantId],
    ),
  );

const driverArm = async (f: Fixture, driverId: string) =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<{ money_armed: boolean; money_armed_at: string | null }>(
        `SELECT money_armed,
                to_char(money_armed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS money_armed_at
           FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [driverId],
      ),
    )
  )[0];

type CardRow = { id: string; last4: string; status: string; is_default: boolean; holder_kind: string; portal_name: string | null };

// The driver's cards keyed by id (the fixture's card was stamped by the database clock, so no
// order between it and a card added here is assumed).
const cardsOf = async (f: Fixture, driverId: string): Promise<Record<string, CardRow>> =>
  Object.fromEntries(
    (
      await admin.withTenant(f.tenantId, (q) =>
        q.query<CardRow>(
          `SELECT CAST(id AS text) AS id, last4, status, is_default, holder_kind, portal_name FROM driver_cards
            WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)`,
          [driverId],
        ),
      )
    ).map((c) => [c.id, c]),
  );
const onlyCard = async (f: Fixture, driverId: string) => {
  const cards = Object.values(await cardsOf(f, driverId));
  expect(cards).toHaveLength(1);
  return cards[0];
};
const defaults = async (f: Fixture, driverId: string) =>
  Object.fromEntries(Object.values(await cardsOf(f, driverId)).map((c) => [c.id, c.is_default]));

beforeAll(() => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
});

beforeEach(async () => {
  const tag = randomUUID().slice(0, 8);
  A = await makeTenant(admin, `parity-a-${tag}`);
  B = await makeTenant(admin, `parity-b-${tag}`);
});

afterEach(async () => {
  await dropTenant(admin, A);
  await dropTenant(admin, B);
});

afterAll(async () => {
  await app?.close();
  await admin?.close();
});

describe("0027's driver tables", () => {
  it("shows another carrier none of a driver's arm log, ids or cards, and refuses rows written across", async () => {
    await makeAdmin(A);
    await armDriver(A.session, A.driverId, { armed: false }, deps());
    await addIdentity(A.session, A.driverId, { system: "tms", externalId: "TMS-100" }, deps());
    expect(await armEvents(A)).toHaveLength(1);
    expect(await armEvents(A, B)).toEqual([]);
    for (const table of ["driver_identities", "driver_arm_events", "driver_cards"]) {
      const seen = await app.withTenant(B.tenantId, (q) =>
        q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = CAST($1 AS uuid)`, [A.tenantId]),
      );
      expect(seen).toEqual([{ n: 0 }]);
    }
    expect(await app.withTenant(B.tenantId, (q) => readDriverIdentity(q, A.driverId))).toBeNull();
    expect(
      await sqlStateOf(
        app.withTenant(B.tenantId, (q) =>
          q.execute(
            `INSERT INTO driver_identities (id, tenant_id, driver_id, system, external_id, source)
             VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), 'tms', 'TMS-200', 'ui')`,
            [randomUUID(), A.tenantId, A.driverId],
          ),
        ),
      ),
    ).toBe("42501");
    // A row in this carrier that names another carrier's driver fails the composite reference.
    expect(
      await sqlStateOf(
        app.withTenant(B.tenantId, (q) =>
          q.execute(
            `INSERT INTO driver_identities (id, tenant_id, driver_id, system, external_id, source)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'tms', 'TMS-200', 'ui')`,
            [randomUUID(), A.driverId],
          ),
        ),
      ),
    ).toBe("23503");
  });

  it("never lets the app rewrite or remove the arm log, and holds its member and note rules", async () => {
    await makeAdmin(A);
    await armDriver(A.session, A.driverId, { armed: false }, deps());
    expect(
      await sqlStateOf(
        app.withTenant(A.tenantId, (q) =>
          q.execute("UPDATE driver_arm_events SET armed = true WHERE tenant_id = current_tenant_id()"),
        ),
      ),
    ).toBe("42501");
    // Nor remove it: only the admin login clears the log (the seed's clearTenantArmLog).
    expect(
      await sqlStateOf(
        app.withTenant(A.tenantId, (q) => q.execute("DELETE FROM driver_arm_events WHERE tenant_id = current_tenant_id()")),
      ),
    ).toBe("42501");
    expect(await armEvents(A)).toHaveLength(1);
    const insert = (membershipId: string | null, source: string, note: string | null = null) =>
      sqlStateOf(
        app.withTenant(A.tenantId, (q) =>
          q.execute(
            `INSERT INTO driver_arm_events (id, tenant_id, driver_id, armed, note, membership_id, source)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), true, $3, CAST($4 AS uuid), $5)`,
            [randomUUID(), A.driverId, note, membershipId, source],
          ),
        ),
      );
    expect(await insert(null, "ui")).toBe("23514");
    expect(await insert(A.memberId, "seed")).toBe("23514");
    expect(await insert(A.memberId, "ui", "")).toBe("23514");
    expect(await insert(A.memberId, "ui", "x".repeat(241))).toBe("23514");
    expect(await insert(B.memberId, "ui")).toBe("23503");
    expect(await insert(A.memberId, "ui", "Checked the license.")).toBe("no error");
  });

  it("holds the identity map's shape and gives each dispatch id to one driver only", async () => {
    const insert = (driverId: string, externalId: string, system = "tms") =>
      sqlStateOf(
        app.withTenant(A.tenantId, (q) =>
          q.execute(
            `INSERT INTO driver_identities (id, tenant_id, driver_id, system, external_id, source)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, 'ui')`,
            [randomUUID(), driverId, system, externalId],
          ),
        ),
      );
    expect(await insert(A.driverId, "TMS-1")).toBe("no error");
    expect(await insert(A.otherDriverId, "TMS-1")).toBe("23505");
    expect(await insert(A.driverId, "has space")).toBe("23514");
    expect(await insert(A.driverId, "x".repeat(41))).toBe("23514");
    expect(await insert(A.driverId, "TMS-2", "eld")).toBe("23514");
    // Another carrier may use the same id for its own driver.
    expect(
      await sqlStateOf(
        app.withTenant(B.tenantId, (q) =>
          q.execute(
            `INSERT INTO driver_identities (id, tenant_id, driver_id, system, external_id, source)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'tms', 'TMS-1', 'ui')`,
            [randomUUID(), B.driverId],
          ),
        ),
      ),
    ).toBe("no error");
  });
});

describe("arming a driver", () => {
  it("lets only an admin arm or disarm, logs each change once, and keeps the last armed time", async () => {
    expect(await armDriver(A.session, A.driverId, { armed: false }, deps())).toEqual({
      ok: false,
      category: "role",
      retryable: false,
    });
    expect(await armEvents(A)).toEqual([]);
    await makeAdmin(A);
    expect(await armDriver(A.session, A.driverId, { armed: false, note: "  License expired.  " }, deps())).toEqual({
      ok: true,
      changed: true,
      armed: false,
      armedAt: "2026-01-01T14:00:00.000Z",
    });
    expect(await driverArm(A, A.driverId)).toEqual({ money_armed: false, money_armed_at: "2026-01-01T14:00:00.000Z" });
    // The same state again changes nothing and logs nothing.
    expect(await armDriver(A.session, A.driverId, { armed: false }, deps())).toMatchObject({ ok: true, changed: false });
    // A minute later, so the log reads in order.
    const later = new Date(NOW + 60_000);
    expect(await armDriver(A.session, A.driverId, { armed: true }, { db: app, clock: () => later })).toEqual({
      ok: true,
      changed: true,
      armed: true,
      armedAt: later.toISOString(),
    });
    expect(await armEvents(A)).toEqual([
      { driver_id: A.driverId, armed: false, note: "License expired.", membership_id: A.memberId, source: "ui" },
      { driver_id: A.driverId, armed: true, note: null, membership_id: A.memberId, source: "ui" },
    ]);
  });

  it("refuses a driver of another carrier, a malformed id and a note too long, changing nothing", async () => {
    await makeAdmin(A);
    expect(await armDriver(A.session, B.driverId, { armed: false }, deps())).toMatchObject({ ok: false, category: "not_found" });
    expect(await armDriver(A.session, "not-a-uuid", { armed: false }, deps())).toMatchObject({ ok: false, category: "bad_request" });
    expect(await armDriver(A.session, A.driverId, { armed: false, note: "x".repeat(241) }, deps())).toMatchObject({
      ok: false,
      category: "bad_request",
    });
    expect(await driverArm(B, B.driverId)).toMatchObject({ money_armed: true });
    expect(await driverArm(A, A.driverId)).toMatchObject({ money_armed: true });
    expect(await armEvents(A)).toEqual([]);
  });
});

describe("a driver's ids and cards", () => {
  it("lets any member add a dispatch id once, and refuses one another driver holds", async () => {
    const first = await addIdentity(A.session, A.driverId, { system: "tms", externalId: "TMS-40217" }, deps());
    expect(first).toMatchObject({ ok: true, changed: true });
    expect(await addIdentity(A.session, A.driverId, { system: "tms", externalId: "TMS-40217" }, deps())).toEqual({
      ...first,
      changed: false,
    });
    expect(await addIdentity(A.session, A.otherDriverId, { system: "tms", externalId: "TMS-40217" }, deps())).toEqual({
      ok: false,
      category: "identity_taken",
      retryable: false,
    });
    expect(await addIdentity(A.session, A.driverId, { system: "tms", externalId: "TMS 1" }, deps())).toMatchObject({
      category: "bad_request",
    });
    expect(await addIdentity(A.session, B.driverId, { system: "tms", externalId: "TMS-9" }, deps())).toMatchObject({
      category: "not_found",
    });
    await addIdentity(A.session, A.driverId, { system: "tms", externalId: "A-7" }, deps());
    const identity = await app.withTenant(A.tenantId, (q) => readDriverIdentity(q, A.driverId));
    expect(identity?.tmsIds).toEqual(["A-7", "TMS-40217"]);
  });

  it("lets only an admin add, close or pick a card, and keeps one default", async () => {
    const input = { last4: "5521", holderKind: "generic" as const, portalName: " pool  card 3 ", makeDefault: false };
    expect(await addCard(A.session, A.driverId, input, deps())).toMatchObject({ ok: false, category: "role" });
    await makeAdmin(A);
    const original = await onlyCard(A, A.driverId);
    const spare = await addCard(A.session, A.driverId, input, deps());
    expect(spare).toMatchObject({ ok: true, changed: true });
    const spareId = (spare as { id: string }).id;
    expect(await cardsOf(A, A.driverId)).toEqual({
      [original.id]: expect.objectContaining({ is_default: true }),
      [spareId]: { id: spareId, last4: "5521", status: "active", is_default: false, holder_kind: "generic", portal_name: "POOL CARD 3" },
    });

    // Picking the spare moves the default; picking it again is no change.
    expect(await setDefaultCard(A.session, A.driverId, spareId, deps())).toEqual({ ok: true, changed: true, id: spareId });
    expect(await setDefaultCard(A.session, A.driverId, spareId, deps())).toEqual({ ok: true, changed: false, id: spareId });
    expect(await defaults(A, A.driverId)).toEqual({ [original.id]: false, [spareId]: true });
    expect(await app.withTenant(A.tenantId, (q) => readDefaultCard(q, A.driverId))).toMatchObject({ id: spareId });

    // Closing the default leaves none until a person picks one; a closed card cannot be picked.
    expect(await closeCard(A.session, A.driverId, spareId, deps())).toEqual({ ok: true, changed: true, id: spareId });
    expect(await closeCard(A.session, A.driverId, spareId, deps())).toEqual({ ok: true, changed: false, id: spareId });
    expect(await app.withTenant(A.tenantId, (q) => readDefaultCard(q, A.driverId))).toBeNull();
    expect(await setDefaultCard(A.session, A.driverId, spareId, deps())).toMatchObject({ category: "card_not_drivers" });
    expect(await setDefaultCard(A.session, A.driverId, original.id, deps())).toMatchObject({ ok: true, changed: true });

    // Another driver's card is never this driver's to close or pick.
    const theirs = await onlyCard(A, A.otherDriverId);
    expect(await closeCard(A.session, A.driverId, theirs.id, deps())).toMatchObject({ category: "card_not_drivers" });
    expect(await setDefaultCard(A.session, A.driverId, theirs.id, deps())).toMatchObject({ category: "card_not_drivers" });
    expect(await onlyCard(A, A.otherDriverId)).toMatchObject({ status: "active", is_default: true });
  });

  it("makes a new card the default when asked or when the driver has none, and refuses a bad card", async () => {
    await makeAdmin(A);
    const original = await onlyCard(A, A.driverId);
    const named = await addCard(A.session, A.driverId, { last4: "1234", holderKind: "named", makeDefault: true }, deps());
    expect(await defaults(A, A.driverId)).toEqual({ [original.id]: false, [(named as { id: string }).id]: true });
    await closeCard(A.session, A.driverId, (named as { id: string }).id, deps());
    const next = await addCard(A.session, A.driverId, { last4: "9876", holderKind: "named", makeDefault: false }, deps());
    expect(await app.withTenant(A.tenantId, (q) => readDefaultCard(q, A.driverId))).toMatchObject({
      id: (next as { id: string }).id,
      last4: "9876",
    });
    for (const bad of [
      { last4: "123", holderKind: "named" as const, makeDefault: false },
      { last4: "1234", holderKind: "generic" as const, makeDefault: false },
      { last4: "1234", holderKind: "generic" as const, portalName: "Pat's card", makeDefault: false },
    ]) {
      expect(await addCard(A.session, A.driverId, bad, deps())).toMatchObject({ category: "bad_request" });
    }
    expect(await addCard(A.session, B.driverId, { last4: "1234", holderKind: "named", makeDefault: false }, deps())).toMatchObject({
      category: "not_found",
    });
    expect(Object.keys(await cardsOf(A, A.driverId))).toHaveLength(3);
  });

  it("reads one driver's identity with the armed flag, the ids and every card, never a token", async () => {
    await makeAdmin(A);
    await setArmed(admin, A, A.driverId, false);
    await addCard(A.session, A.driverId, { last4: "0007", holderKind: "generic", portalName: "YARD 2", makeDefault: false }, deps());
    await addIdentity(A.session, A.driverId, { system: "tms", externalId: "TMS-1" }, deps());
    const identity = await app.withTenant(A.tenantId, (q) => readDriverIdentity(q, A.driverId));
    expect(identity).toMatchObject({ driverId: A.driverId, code: "DRV-1", armed: { on: false, since: null }, tmsIds: ["TMS-1"] });
    expect(identity?.cards.map((c) => [c.isDefault, c.holderKind, c.portalName])).toEqual([
      [true, "named", null],
      [false, "generic", "YARD 2"],
    ]);
    expect(JSON.stringify(identity)).not.toMatch(/fcs_card_|token/i);
  });
});
