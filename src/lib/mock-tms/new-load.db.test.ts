import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { readRole } from "../auth/role";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { moveFromTmsEvent } from "../loads/movement";
import { addJudge, dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { syntheticLabelMap } from "../tms/status";
import { pullTms } from "../tms/sync";
import { createMockLoad, type NewLoadInput } from "./new-load";
import { applyMockAction, type MockAction, type MockWho } from "./store";

// "New load" in the sample dispatch system against a fresh database, as the app's role: both sides
// written in one transaction, the mirror linking them by number on its first read, and the load
// then moved by the sample system's own clicks. Fixed clocks only (never the wall clock). The
// carriers are America/Chicago (makeTenant); only this file's carriers are made, removed after.

const MOCK_TABLES = ["mock_tms_loads", "mock_tms_stops", "mock_tms_events", "mock_tms_lines"] as const;
const MIRROR_TABLES = ["tms_loads", "tms_stops", "tms_status_events", "tms_line_items", "tms_documents"] as const;
const savedTms = structuredClone(flags.tmsSync);
const savedMove = structuredClone(flags.loadMovement);

// Tuesday Nov 3, 2026, 9:00 CST.
const T0 = "2026-11-03T15:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * MIN);

let admin: Db;
let app: Db;
const made: Fixture[] = [];

type Carrier = Fixture & { token: string };

// A carrier on the sample system, with its customer (CUST-1) and two drivers there; drv-1 maps to
// our first driver, drv-2 to none of ours.
async function carrier(name: string): Promise<Carrier> {
  const f = await makeTenant(admin, `${name}-${randomUUID().slice(0, 6)}`);
  made.push(f);
  const token = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO tms_connections (id, tenant_id, system, label_map, lookback_hours, finalize_cooloff_minutes, demo_faults)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'mock', CAST($2 AS jsonb), 4, 2, CAST('{}' AS jsonb))`,
      [randomUUID(), JSON.stringify(syntheticLabelMap())],
    );
    await q.execute(
      `INSERT INTO desk_loops (tenant_id, lease_token, lease_until, updated_at)
       VALUES (current_tenant_id(), CAST($1 AS uuid), CAST('2026-11-30T00:00:00Z' AS timestamptz),
               CAST('2026-10-25T00:00:00Z' AS timestamptz))`,
      [token],
    );
    await q.execute(
      `INSERT INTO mock_tms_parties (id, tenant_id, kind, external_id, name)
       VALUES (gen_random_uuid(), current_tenant_id(), 'customer', 'CUST-1', 'Sample Shipper'),
              (gen_random_uuid(), current_tenant_id(), 'customer', 'CUST-9', 'Nobody Of Ours'),
              (gen_random_uuid(), current_tenant_id(), 'driver', 'drv-1', 'Sample Driver One'),
              (gen_random_uuid(), current_tenant_id(), 'driver', 'drv-2', 'Sample Driver Two')`,
    );
    await q.execute(
      `INSERT INTO driver_identities (id, tenant_id, driver_id, system, external_id, source)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 'tms', 'drv-1', 'seed')`,
      [f.driverId],
    );
  });
  return { ...f, token };
}

let seq = 0;
const input = (over: Partial<NewLoadInput> = {}): NewLoadInput => {
  seq += 1;
  return {
    loadNumber: `NEW-${1000 + seq}`,
    customerCode: "CUST-1",
    pickup: { name: "Sample Dock", city: "Joliet", state: "IL", on: "2026-11-03" },
    delivery: { name: "Sample Yard", city: "Gary", state: "IN", on: "2026-11-03" },
    loadedMiles: 420,
    linehaulCents: 150_000,
    fuelSurchargeCents: 12_500,
    driverExternalId: "drv-1",
    ...over,
  };
};

const create = (f: Fixture, i: NewLoadInput, nowMinutes = 0, opts: { who?: MockWho; cap?: number } = {}) =>
  app.withTenant(f.tenantId, (q) =>
    createMockLoad(q, i, opts.who ?? "staff", { nowMs: at(nowMinutes).getTime(), maxNewLoads: opts.cap ?? 40, maxEventsPerLoad: 36 }),
  );

const act = (f: Fixture, reference: string, action: MockAction, nowMinutes: number) =>
  app.withTenant(f.tenantId, (q) => applyMockAction(q, reference, action, "staff", { nowMs: at(nowMinutes).getTime(), maxEventsPerLoad: 36 }));

const pull = (f: Carrier, now: Date) =>
  pullTms(app, f.session, { token: f.token, now, deadlineMs: now.getTime() + MIN }, { clock: () => now.getTime() });

const ts = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const countsOf = (f: Fixture, tables: readonly string[], db: Db = admin) =>
  db.withTenant(f.tenantId, async (q) => {
    const out: Record<string, number> = {};
    for (const t of tables) {
      const [r] = await q.query<{ n: number }>(`SELECT CAST(count(*) AS integer) AS n FROM ${t} WHERE tenant_id = current_tenant_id()`);
      out[t] = r.n;
    }
    return out;
  });

const ourLoads = (f: Fixture, db: Db = admin) =>
  db.withTenant(f.tenantId, (q) =>
    q.query<{
      id: string;
      load_number: string;
      status: string;
      customer_id: string;
      driver_id: string | null;
      origin_city: string;
      dest_state: string;
      pickup_on: string;
      loaded_miles: number;
      empty_miles: number;
      linehaul_cents: number;
      fuel_surcharge_cents: number;
    }>(
      `SELECT CAST(id AS text) AS id, load_number, status, CAST(customer_id AS text) AS customer_id,
              CAST(driver_id AS text) AS driver_id, origin_city, dest_state, to_char(pickup_on, 'YYYY-MM-DD') AS pickup_on,
              loaded_miles, empty_miles, CAST(linehaul_cents AS integer) AS linehaul_cents,
              CAST(fuel_surcharge_cents AS integer) AS fuel_surcharge_cents
         FROM loads WHERE tenant_id = current_tenant_id() ORDER BY load_number`,
    ),
  );

const mockOf = (f: Fixture, reference: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [load] = await q.query<{ id: string; external_id: string; status_label: string; driver_external_id: string | null; seeded: boolean }>(
      `SELECT CAST(id AS text) AS id, external_id, status_label, driver_external_id, seeded
         FROM mock_tms_loads WHERE tenant_id = current_tenant_id() AND reference = $1`,
      [reference],
    );
    const stops = await q.query<{ ordinal: number; stop_kind: string; appt_from_local: string; appt_to_local: string }>(
      `SELECT ordinal, stop_kind, appt_from_local, appt_to_local FROM mock_tms_stops
        WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid) ORDER BY ordinal`,
      [load.id],
    );
    const lines = await q.query<{ external_id: string; type_label: string; amount_cents: number }>(
      `SELECT external_id, type_label, amount_cents FROM mock_tms_lines
        WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid) ORDER BY external_id`,
      [load.id],
    );
    const events = await q.query<{ seq: number; field: string; previous_value: string | null; new_value: string | null; changed_by: string; at: string }>(
      `SELECT seq, field, previous_value, new_value, changed_by, ${ts("at")} AS at FROM mock_tms_events
        WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid) ORDER BY seq`,
      [load.id],
    );
    return { load, stops, lines, events };
  });

const mirrorOf = (f: Fixture, externalId: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<{ status_code: string; load_id: string | null; flags: string[]; revenue_total_cents: number | null }>(
      `SELECT status_code, CAST(load_id AS text) AS load_id, flags, CAST(revenue_total_cents AS integer) AS revenue_total_cents
         FROM tms_loads WHERE tenant_id = current_tenant_id() AND external_id = $1`,
      [externalId],
    );
    return row;
  });

const statusEvent = (f: Fixture, externalId: string, label: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const rows = await q.query<{ id: string }>(
      `SELECT CAST(e.id AS text) AS id FROM tms_status_events e JOIN tms_loads m ON m.tenant_id = e.tenant_id AND m.id = e.tms_load_id
        WHERE e.tenant_id = current_tenant_id() AND m.external_id = $1 AND e.new_value = $2`,
      [externalId, label],
    );
    expect(rows).toHaveLength(1);
    return rows[0].id;
  });

const loadEventsOf = (f: Fixture, loadId: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM load_events WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)
        ORDER BY at, created_at`,
      [loadId],
    ),
  );

beforeAll(() => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl(), max: 2 });
});

afterAll(async () => {
  for (const f of made) await dropTenant(admin, f);
  await app?.close();
  await admin?.close();
});

beforeEach(() => {
  Object.assign(flags.tmsSync, savedTms, { enabled: true, startDate: "2026-10-25", demoFaultsEnabled: true });
  flags.loadMovement.enabled = true;
  flags.loadMovement.startDate = "2026-10-25";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(flags.tmsSync, savedTms);
  Object.assign(flags.loadMovement, savedMove);
  vi.restoreAllMocks();
});

describe("a new load in the sample dispatch system", () => {
  it("writes both sides at once, is linked on the first read, and then moves with the sample system's clicks", async () => {
    const f = await carrier("nl-flow");
    const i = input();
    const out = await create(f, i);
    expect(out).toMatchObject({ ok: true, externalId: `mock:${i.loadNumber}`, reference: i.loadNumber, at: T0 });
    if (!out.ok) throw new Error("not created");

    // Ours: planned, the customer and driver resolved by whole code and id, the rate in cents.
    expect(await ourLoads(f)).toEqual([
      {
        id: out.loadId,
        load_number: i.loadNumber,
        status: "planned",
        customer_id: f.customerId,
        driver_id: f.driverId,
        origin_city: "Joliet",
        dest_state: "IN",
        pickup_on: "2026-11-03",
        loaded_miles: 420,
        empty_miles: 0,
        linehaul_cents: 150_000,
        fuel_surcharge_cents: 12_500,
      },
    ]);
    // Theirs: Booked by the driver, two stops with derived windows, two lines, three history rows.
    const mock = await mockOf(f, i.loadNumber);
    expect(mock.load).toMatchObject({ external_id: `mock:${i.loadNumber}`, status_label: "Booked", driver_external_id: "drv-1", seeded: false });
    expect(mock.stops).toEqual([
      { ordinal: 0, stop_kind: "pickup", appt_from_local: "2026-11-03T08:00", appt_to_local: "2026-11-03T16:00" },
      { ordinal: 1, stop_kind: "delivery", appt_from_local: "2026-11-03T08:00", appt_to_local: "2026-11-03T16:00" },
    ]);
    expect(mock.lines).toEqual([
      { external_id: `mock:${i.loadNumber}:line1`, type_label: "Linehaul", amount_cents: 150_000 },
      { external_id: `mock:${i.loadNumber}:line2`, type_label: "Fuel Surcharge", amount_cents: 12_500 },
    ]);
    expect(mock.events).toEqual([
      { seq: 1, field: "status", previous_value: null, new_value: "New", changed_by: "Dispatch desk", at: T0 },
      { seq: 2, field: "driver", previous_value: null, new_value: "drv-1", changed_by: "Dispatch desk", at: "2026-11-03T15:00:01.000Z" },
      { seq: 3, field: "status", previous_value: "New", new_value: "Booked", changed_by: "Dispatch desk", at: "2026-11-03T15:00:01.000Z" },
    ]);

    // The first read links it by number; a second read with nothing new writes nothing.
    await pull(f, at(1));
    expect(await mirrorOf(f, out.externalId)).toEqual({ status_code: "booked", load_id: out.loadId, flags: [], revenue_total_cents: 162_500 });
    const before = await countsOf(f, MIRROR_TABLES);
    await pull(f, at(2));
    expect(await countsOf(f, MIRROR_TABLES)).toEqual(before);

    // Pickup, then delivery, each mirrored and each moving our load once.
    expect(await act(f, i.loadNumber, { kind: "complete_pickup", arrivedLocal: null, departedLocal: null }, 5)).toMatchObject({ ok: true });
    await pull(f, at(6));
    const picked = await statusEvent(f, out.externalId, "In Transit");
    expect(await app.withTenant(f.tenantId, (q) => moveFromTmsEvent(q, f.session, picked, at(6)))).toMatchObject({ kind: "moved" });
    expect(await act(f, i.loadNumber, { kind: "complete_delivery", arrivedLocal: null, departedLocal: null }, 300)).toMatchObject({ ok: true });
    await pull(f, at(301));
    const delivered = await statusEvent(f, out.externalId, "Delivered");
    expect(await app.withTenant(f.tenantId, (q) => moveFromTmsEvent(q, f.session, delivered, at(301)))).toMatchObject({ kind: "moved" });
    expect((await ourLoads(f))[0].status).toBe("delivered");
    expect(await loadEventsOf(f, out.loadId)).toEqual([
      { from_status: "planned", to_status: "in_transit" },
      { from_status: "in_transit", to_status: "delivered" },
    ]);
  });

  it("leaves the driver off both sides when none is picked, and the fuel line off at zero", async () => {
    const f = await carrier("nl-nodrv");
    const i = input({ driverExternalId: null, fuelSurchargeCents: 0 });
    expect(await create(f, i)).toMatchObject({ ok: true });
    expect((await ourLoads(f))[0]).toMatchObject({ driver_id: null, fuel_surcharge_cents: 0 });
    const mock = await mockOf(f, i.loadNumber);
    expect(mock.load).toMatchObject({ status_label: "New", driver_external_id: null });
    expect(mock.lines.map((l) => l.type_label)).toEqual(["Linehaul"]);
    expect(mock.events).toHaveLength(1);
  });

  it("refuses, writing nothing on either side: a number taken, an unknown customer or driver, a date out of range, past the cap", async () => {
    const f = await carrier("nl-refuse");
    const first = input();
    expect(await create(f, first)).toMatchObject({ ok: true });
    const counted = async () => ({ ...(await countsOf(f, MOCK_TABLES)), loads: (await ourLoads(f)).length });
    const before = await counted();

    expect(await create(f, { ...input(), loadNumber: first.loadNumber })).toEqual({ ok: false, category: "exists" });
    // A number only our side holds is taken too: the form never adopts a load.
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `INSERT INTO loads (id, tenant_id, load_number, customer_id, status, origin_city, origin_state, dest_city, dest_state,
           pickup_on, loaded_miles, linehaul_cents)
         VALUES (gen_random_uuid(), current_tenant_id(), 'OURS-1', CAST($1 AS uuid), 'planned', 'Joliet', 'IL', 'Gary', 'IN',
           CAST('2026-11-03' AS date), 100, 1000)`,
        [f.customerId],
      ),
    );
    expect(await create(f, input({ loadNumber: "OURS-1" }))).toEqual({ ok: false, category: "exists" });
    // CUST-9 is the sample system's only; CUST-2 is nobody's.
    expect(await create(f, input({ customerCode: "CUST-9" }))).toEqual({ ok: false, category: "unknown_customer" });
    expect(await create(f, input({ customerCode: "CUST-2" }))).toEqual({ ok: false, category: "unknown_customer" });
    // drv-2 maps to none of ours; drv-9 is nobody's.
    expect(await create(f, input({ driverExternalId: "drv-2" }))).toEqual({ ok: false, category: "unknown_driver" });
    expect(await create(f, input({ driverExternalId: "drv-9" }))).toEqual({ ok: false, category: "unknown_driver" });
    const late = input();
    expect(await create(f, { ...late, pickup: { ...late.pickup, on: "2026-11-18" }, delivery: { ...late.delivery, on: "2026-11-18" } })).toEqual({
      ok: false,
      category: "bad_date",
    });
    expect(await create(f, { ...late, delivery: { ...late.delivery, on: "2026-11-02" } })).toEqual({ ok: false, category: "bad_date" });
    expect(await counted()).toEqual({ ...before, loads: before.loads + 1 });

    // The cap counts only loads made here: one made, a cap of two takes one more and refuses the next.
    expect(await create(f, input(), 1, { cap: 2 })).toMatchObject({ ok: true });
    const capped = await counted();
    expect(await create(f, input(), 2, { cap: 2 })).toEqual({ ok: false, category: "cap" });
    expect(await counted()).toEqual(capped);
  });

  it("is refused for a carrier not on the sample system, and each carrier sees only its own", async () => {
    const a = await carrier("nl-rls-a");
    const b = await carrier("nl-rls-b");
    expect(await create(a, input())).toMatchObject({ ok: true });
    expect(await countsOf(b, MOCK_TABLES, app)).toEqual({ mock_tms_loads: 0, mock_tms_stops: 0, mock_tms_events: 0, mock_tms_lines: 0 });
    expect(await ourLoads(b, app)).toEqual([]);
    const crossed = await app.withTenant(b.tenantId, (q) =>
      q.query<{ n: number }>("SELECT CAST((SELECT count(*) FROM mock_tms_loads) + (SELECT count(*) FROM loads) AS integer) AS n"),
    );
    expect(crossed[0].n).toBe(0);

    await admin.withTenant(b.tenantId, (q) => q.execute("UPDATE tms_connections SET system = 'synthetic' WHERE tenant_id = current_tenant_id()"));
    expect(await create(b, input())).toEqual({ ok: false, category: "not_found" });
    expect(await ourLoads(b)).toEqual([]);
  });

  it("lets a demo visitor create one, recorded as the visitor", async () => {
    const f = await carrier("nl-judge");
    const judge = await addJudge(admin, f);
    const i = input();
    const out = await app.withTenant(f.tenantId, async (q) => {
      const role = await readRole(q, judge);
      return createMockLoad(q, i, role, { nowMs: at(0).getTime(), maxNewLoads: 40, maxEventsPerLoad: 36 });
    });
    expect(out).toMatchObject({ ok: true });
    expect((await mockOf(f, i.loadNumber)).events.map((e) => e.changed_by)).toEqual(["Demo visitor", "Demo visitor", "Demo visitor"]);
  });
});
