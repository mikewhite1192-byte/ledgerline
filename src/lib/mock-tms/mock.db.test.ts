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
import { applyMockAction, type MockAction, type MockWho } from "./store";

// The sample dispatch system against a fresh database, as the app's role: its own store, the
// `mock` source the sync picks for a connection on it (no stand-in source), and the mirror and the
// load movement after it. Fixed clocks only (never the wall clock). The carriers are
// America/Chicago (makeTenant); only this file's carriers are made, removed after.

const MOCK_TABLES = [
  "mock_tms_loads",
  "mock_tms_stops",
  "mock_tms_events",
  "mock_tms_lines",
  "mock_tms_documents",
  "mock_tms_parties",
] as const;
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
let seq = 0;

type Carrier = Fixture & { token: string; slug: string };

async function carrier(name: string): Promise<Carrier> {
  const slug = `${name}-${randomUUID().slice(0, 6)}`;
  const f = await makeTenant(admin, slug);
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
       VALUES (gen_random_uuid(), current_tenant_id(), 'driver', 'drv-1', 'Sample Driver One'),
              (gen_random_uuid(), current_tenant_id(), 'driver', 'drv-2', 'Sample Driver Two')`,
    );
  });
  return { ...f, token, slug };
}

type MockLoad = { reference: string; externalId: string; ourId: string | null };

// A load in the sample system, created two hours before T0 and last changed one hour before, with
// a pickup and a delivery and a linehaul line; with `linked`, a planned load of ours by the same number.
async function mockLoad(f: Carrier, over: { status?: string; driver?: string | null; linked?: boolean } = {}): Promise<MockLoad> {
  seq += 1;
  const reference = `ML${20000 + seq}`;
  const externalId = `syn:${f.slug}:${reference}`;
  const id = randomUUID();
  const ourId = over.linked === false ? null : randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    if (ourId !== null) {
      await q.execute(
        `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
           dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), 'planned', 'Joliet', 'IL',
           'Gary', 'IN', CAST('2026-11-03' AS date), 420, 150000)`,
        [ourId, reference, f.customerId, f.driverId],
      );
    }
    await q.execute(
      `INSERT INTO mock_tms_loads (id, tenant_id, external_id, reference, status_label, customer_external_id, customer_name,
         driver_external_id, truck_unit, created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, 'cus-1', 'Sample Shipper', $5, '101',
               CAST($6 AS timestamptz), CAST($7 AS timestamptz))`,
      [id, externalId, reference, over.status ?? "Booked", over.driver === undefined ? "drv-1" : over.driver, at(-120).toISOString(), at(-60).toISOString()],
    );
    await q.execute(
      `INSERT INTO mock_tms_stops (id, tenant_id, mock_load_id, ordinal, stop_kind, name, city, state, appt_from_local, appt_to_local)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 0, 'pickup', 'Sample Dock', 'Joliet', 'IL',
               '2026-11-03T08:00', '2026-11-03T10:00'),
              (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 1, 'delivery', 'Sample Yard', 'Gary', 'IN',
               '2026-11-03T14:00', '2026-11-03T16:00')`,
      [id],
    );
    await q.execute(
      `INSERT INTO mock_tms_lines (id, tenant_id, mock_load_id, external_id, item_group, type_label, description, amount_cents)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), $2, 'revenue', 'Linehaul', 'Linehaul', 150000)`,
      [id, `${externalId}:l1`],
    );
    await q.execute(
      `INSERT INTO mock_tms_events (id, tenant_id, mock_load_id, seq, external_id, field, new_value, previous_value, changed_by, at)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 1, $2, 'status', $3, NULL, 'Dispatch desk',
               CAST($4 AS timestamptz))`,
      [id, `${externalId}:e1`, over.status ?? "Booked", at(-60).toISOString()],
    );
  });
  return { reference, externalId, ourId };
}

const act = (f: Fixture, reference: string, action: MockAction, nowMinutes: number, opts: { who?: MockWho; cap?: number } = {}) =>
  app.withTenant(f.tenantId, (q) =>
    applyMockAction(q, reference, action, opts.who ?? "staff", { nowMs: at(nowMinutes).getTime(), maxEventsPerLoad: opts.cap ?? 200 }),
  );

const pull = (f: Carrier, now: Date) =>
  pullTms(app, f.session, { token: f.token, now, deadlineMs: now.getTime() + MIN }, { clock: () => now.getTime() });

const ts = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const mirrorOf = (f: Fixture, externalId: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<{
      status_code: string;
      status_label: string;
      delivered_at: string | null;
      revenue_total_cents: number | null;
      load_id: string | null;
    }>(
      `SELECT status_code, status_label, ${ts("delivered_at")} AS delivered_at,
              CAST(revenue_total_cents AS integer) AS revenue_total_cents, CAST(load_id AS text) AS load_id
         FROM tms_loads WHERE tenant_id = current_tenant_id() AND external_id = $1`,
      [externalId],
    );
    return row;
  });

const countsOf = (f: Fixture, tables: readonly string[], db: Db = admin) =>
  db.withTenant(f.tenantId, async (q) => {
    const out: Record<string, number> = {};
    for (const t of tables) {
      const [r] = await q.query<{ n: number }>(`SELECT CAST(count(*) AS integer) AS n FROM ${t} WHERE tenant_id = current_tenant_id()`);
      out[t] = r.n;
    }
    return out;
  });

const mirrorEvent = (f: Fixture, externalEventId: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<{ id: string; new_value: string | null; seeded: boolean }>(
      `SELECT CAST(id AS text) AS id, new_value, seeded FROM tms_status_events
        WHERE tenant_id = current_tenant_id() AND external_event_id = $1`,
      [externalEventId],
    );
    return row;
  });

const historyOf = (f: Fixture, reference: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ seq: number; field: string; previous_value: string | null; new_value: string | null; changed_by: string | null; at: string }>(
      `SELECT CAST(e.seq AS integer) AS seq, e.field, e.previous_value, e.new_value, e.changed_by, ${ts("e.at")} AS at
         FROM mock_tms_events e JOIN mock_tms_loads l ON l.tenant_id = e.tenant_id AND l.id = e.mock_load_id
        WHERE e.tenant_id = current_tenant_id() AND l.reference = $1 ORDER BY e.seq`,
      [reference],
    ),
  );

const ourStatus = (f: Fixture, id: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [r] = await q.query<{ status: string }>(
      "SELECT status FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [id],
    );
    return r.status;
  });

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

describe("the sample dispatch system", () => {
  it("keeps each carrier's rows to itself", async () => {
    const a = await carrier("mk-rls-a");
    const b = await carrier("mk-rls-b");
    await mockLoad(a);
    const mine = await countsOf(a, MOCK_TABLES, app);
    // A's load has no document until its delivery is completed.
    for (const t of MOCK_TABLES) if (t !== "mock_tms_documents") expect(mine[t]).toBeGreaterThan(0);
    // B sees only its own two drivers, never A's rows.
    expect(await countsOf(b, MOCK_TABLES, app)).toEqual({
      mock_tms_loads: 0,
      mock_tms_stops: 0,
      mock_tms_events: 0,
      mock_tms_lines: 0,
      mock_tms_documents: 0,
      mock_tms_parties: 2,
    });
    const crossed = await app.withTenant(b.tenantId, (q) =>
      q.query<{ n: number }>("SELECT CAST(count(*) AS integer) AS n FROM mock_tms_loads"),
    );
    expect(crossed[0].n).toBe(0);
  });

  it("is read by the desk like a real system: completing the pickup and the delivery each mirror one event and move our load once", async () => {
    const f = await carrier("mk-flow");
    const l = await mockLoad(f);
    await pull(f, at(0));
    expect(await mirrorOf(f, l.externalId)).toMatchObject({
      status_code: "booked",
      status_label: "Booked",
      delivered_at: null,
      revenue_total_cents: 150000,
      load_id: l.ourId,
    });

    expect(await act(f, l.reference, { kind: "complete_pickup", arrivedLocal: null, departedLocal: null }, 5)).toMatchObject({ ok: true });
    await pull(f, at(6));
    expect((await mirrorOf(f, l.externalId))?.status_code).toBe("in_transit");
    const picked = await mirrorEvent(f, `${l.externalId}:e2`);
    expect(picked).toMatchObject({ new_value: "In Transit", seeded: false });
    expect(await app.withTenant(f.tenantId, (q) => moveFromTmsEvent(q, f.session, picked.id, at(6)))).toMatchObject({ kind: "moved" });
    expect(await ourStatus(f, l.ourId as string)).toBe("in_transit");
    expect(await app.withTenant(f.tenantId, (q) => moveFromTmsEvent(q, f.session, picked.id, at(6)))).toMatchObject({ kind: "already" });

    // A second read with nothing new writes nothing.
    const before = await countsOf(f, MIRROR_TABLES);
    await pull(f, at(7));
    expect(await countsOf(f, MIRROR_TABLES)).toEqual(before);

    // The delivery, typed at 1:30 to 1:45 PM local, records a proof of delivery and moves the load.
    const done = await act(
      f,
      l.reference,
      { kind: "complete_delivery", arrivedLocal: "2026-11-03T13:30", departedLocal: "2026-11-03T13:45" },
      300,
    );
    expect(done).toMatchObject({ ok: true });
    await pull(f, at(301));
    expect(await mirrorOf(f, l.externalId)).toMatchObject({ status_code: "delivered", delivered_at: "2026-11-03T19:45:00.000Z" });
    const pods = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ n: number }>(
        "SELECT CAST(count(*) AS integer) AS n FROM tms_documents WHERE tenant_id = current_tenant_id() AND type_label = 'Proof of Delivery'",
      ),
    );
    expect(pods[0].n).toBe(1);
    const delivered = await mirrorEvent(f, `${l.externalId}:e3`);
    expect(delivered).toMatchObject({ new_value: "Delivered", seeded: false });
    expect(await app.withTenant(f.tenantId, (q) => moveFromTmsEvent(q, f.session, delivered.id, at(301)))).toMatchObject({ kind: "moved" });
    expect(await ourStatus(f, l.ourId as string)).toBe("delivered");

    // Every change is one history row: from, to, who, when.
    expect(await historyOf(f, l.reference)).toEqual([
      { seq: 1, field: "status", previous_value: null, new_value: "Booked", changed_by: "Dispatch desk", at: at(-60).toISOString() },
      { seq: 2, field: "status", previous_value: "Booked", new_value: "In Transit", changed_by: "Dispatch desk", at: at(5).toISOString() },
      // A completed stop is dated at its departure (1:45 PM local), not at the click.
      { seq: 3, field: "status", previous_value: "In Transit", new_value: "Delivered", changed_by: "Dispatch desk", at: "2026-11-03T19:45:00.000Z" },
    ]);
  });

  it("refuses Booked without a driver, Delivered without a proof of delivery, and a delivery before its pickup", async () => {
    const f = await carrier("mk-needs");
    const l = await mockLoad(f, { status: "New", driver: null, linked: false });
    expect(await act(f, l.reference, { kind: "set_status", code: "booked" }, 1)).toEqual({ ok: false, category: "no_driver" });
    expect(await act(f, l.reference, { kind: "set_status", code: "delivered" }, 1)).toEqual({ ok: false, category: "no_pod" });
    expect(await act(f, l.reference, { kind: "complete_delivery", arrivedLocal: null, departedLocal: null }, 1)).toEqual({
      ok: false,
      category: "pickup_first",
    });
    expect(await act(f, l.reference, { kind: "set_status", code: "custom" }, 1)).toEqual({ ok: false, category: "bad_status" });
    expect(await act(f, l.reference, { kind: "set_status", code: "new" }, 1)).toEqual({ ok: false, category: "same_status" });
    expect(await historyOf(f, l.reference)).toHaveLength(1);

    // Assigning a driver books it (two rows); a person may then move it backward.
    expect(await act(f, l.reference, { kind: "assign_driver", driverExternalId: "drv-2" }, 2)).toMatchObject({ ok: true });
    expect(await act(f, l.reference, { kind: "set_status", code: "tendered" }, 3)).toMatchObject({ ok: true });
    expect((await historyOf(f, l.reference)).map((h) => [h.field, h.previous_value, h.new_value])).toEqual([
      ["status", null, "New"],
      ["driver", null, "drv-2"],
      ["status", "New", "Booked"],
      ["status", "Booked", "Tendered"],
    ]);
    expect(await act(f, l.reference, { kind: "assign_driver", driverExternalId: "drv-9" }, 4)).toEqual({ ok: false, category: "unknown_driver" });
  });

  it("stops at the history cap and writes nothing", async () => {
    const f = await carrier("mk-cap");
    const l = await mockLoad(f, { linked: false });
    expect(await act(f, l.reference, { kind: "set_status", code: "on_hold" }, 1, { cap: 1 })).toEqual({ ok: false, category: "cap" });
    expect(await historyOf(f, l.reference)).toHaveLength(1);
  });

  it("lets a demo visitor move a load, recorded as the visitor", async () => {
    const f = await carrier("mk-judge");
    const l = await mockLoad(f, { linked: false });
    const judge = await addJudge(admin, f);
    const out = await app.withTenant(f.tenantId, async (q) => {
      const role = await readRole(q, judge);
      return applyMockAction(q, l.reference, { kind: "set_status", code: "archived" }, role, {
        nowMs: at(1).getTime(),
        maxEventsPerLoad: 200,
      });
    });
    expect(out).toMatchObject({ ok: true });
    expect((await historyOf(f, l.reference))[1]).toMatchObject({ new_value: "Archived", changed_by: "Demo visitor" });
  });
});
