import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type {
  ListBookmark,
  TmsDocumentRow,
  TmsHistoryRow,
  TmsLineItem,
  TmsListRow,
  TmsLoadRecord,
  TmsSource,
} from "../adapters/tms-source/types";
import { TmsSourceError } from "../adapters/tms-source/types";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { deskHandlers, type Handlers } from "../desk/handlers";
import { DESK_SOURCES, eventKey } from "../desk/keys";
import { wakeDesk } from "../desk/loop";
import { moveFromTmsEvent } from "../loads/movement";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { serviceSession } from "../sweep/service-session";
import { clocksOf } from "./clocks";
import { syntheticLabelMap } from "./status";
import { pullTms, syncDispatchNow } from "./sync";

// The dispatch mirror against a fresh database, as the app's role, with a hand-rolled TMS source
// (every source goes through the validating wrapper, as in production) and a fixed clock. The
// carriers are America/Chicago (makeTenant); only this file's carriers are made, removed after.

// Monday Nov 2, 2026, 12:00 in Chicago (CST since Nov 1).
const NOW = new Date("2026-11-02T18:00:00.000Z");
const ZONE = "America/Chicago";
const TABLES = [
  "tms_connections",
  "tms_parties",
  "tms_loads",
  "tms_stops",
  "tms_status_events",
  "tms_line_items",
  "tms_documents",
] as const;
const savedTms = structuredClone(flags.tmsSync);
const savedMove = structuredClone(flags.loadMovement);
const savedDesk = structuredClone(flags.deskLoop);

// ---------------------------------------------------------------------------------------------
// The fake dispatch system: whole records by id, a list from them, history paged by two.

type FakeLoad = {
  createdAt: string;
  record: TmsLoadRecord;
  history: TmsHistoryRow[];
  documents: TmsDocumentRow[];
  lines: TmsLineItem[];
};

class FakeTms {
  loads = new Map<string, FakeLoad>();
  failing = new Set<string>();
  calls: string[] = [];
  historyPage = 2;
  // A row repeated at the top of the next history page (a vendor's cut), when set.
  repeatAcrossPages = false;

  source(): TmsSource {
    const gone = { kind: "gone" } as const;
    const ok = <T>(value: T) => ({ kind: "ok" as const, value, asOf: NOW.toISOString() });
    const get = (id: string) => {
      if (this.failing.has(id)) throw new TmsSourceError("server_error");
      return this.loads.get(id);
    };
    return {
      system: "synthetic",
      ready: async () => ({ ok: true }),
      listLoads: async (_ctx, below: ListBookmark | null, limit) => {
        this.calls.push("list");
        const rows: TmsListRow[] = [...this.loads.values()]
          .map((l) => ({
            externalId: l.record.externalId,
            createdAt: l.createdAt,
            updatedAt: l.record.updatedAt,
            statusLabel: l.record.statusLabel,
            reference: l.record.reference,
            driverExternalId: l.record.driverExternalId,
          }))
          .filter((r) => below === null || r.createdAt < below.createdAt || (r.createdAt === below.createdAt && r.externalId < below.id))
          .sort((a, b) => (a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : a.externalId < b.externalId ? 1 : -1));
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return { rows: page, next: rows.length > limit ? { createdAt: last.createdAt, id: last.externalId } : null };
      },
      readLoad: async (_ctx, id) => {
        this.calls.push(`load:${id}`);
        const l = get(id);
        return l ? ok(l.record) : gone;
      },
      readHistory: async (_ctx, id, page) => {
        const l = get(id);
        if (!l) return gone;
        const n = this.historyPage;
        const rows = l.history.slice(page * n, (page + 1) * n);
        if (this.repeatAcrossPages && page > 0 && rows.length > 0) rows.unshift(l.history[page * n - 1]);
        return ok(rows);
      },
      readDocuments: async (_ctx, id) => {
        const l = get(id);
        return l ? ok(l.documents) : gone;
      },
      readLineItems: async (_ctx, id) => {
        const l = get(id);
        return l ? ok(l.lines) : gone;
      },
      readParty: async (_ctx, kind, id) => ok({ partyKind: kind, externalId: id, name: "Test Driver", unit: null, vin: null }),
    };
  }
}

let fake = new FakeTms();
vi.mock("../adapters/tms-source", async (importOriginal) => {
  const real = await importOriginal<typeof import("../adapters/tms-source")>();
  return { ...real, tmsSource: () => real.validated(fake.source()) };
});

const LABEL = { tendered: "Tendered", in_transit: "In Transit", delivered: "Delivered", cancelled: "Cancelled" } as const;

// A load as the dispatch system shows it, every step before `upTo` in its history.
function dispatchLoad(
  externalId: string,
  reference: string,
  steps: { label: string; at: string }[],
  over: Partial<TmsLoadRecord> = {},
): FakeLoad {
  const last = steps[steps.length - 1];
  const deliveredStep = steps.find((s) => s.label === LABEL.delivered);
  const pickedStep = steps.find((s) => s.label === LABEL.in_transit);
  const delivery = deliveredStep
    ? {
        arrived: clocksOf(new Date(Date.parse(deliveredStep.at) - 3_600_000).toISOString(), ZONE),
        completed: clocksOf(deliveredStep.at, ZONE),
      }
    : { arrived: null, completed: null };
  return {
    createdAt: steps[0].at,
    record: {
      externalId,
      reference,
      statusLabel: last.label,
      customer: { externalId: "CUST-1", name: "Test Shipper" },
      driverExternalId: "drv-1",
      truckUnit: null,
      trailerUnit: null,
      vin: null,
      pickups: [
        {
          name: "Joliet pickup",
          city: "Joliet",
          state: "IL",
          apptFromLocal: "2026-11-01T08:00",
          apptToLocal: "2026-11-01T12:00",
          arrived: pickedStep ? clocksOf(new Date(Date.parse(pickedStep.at) - 3_600_000).toISOString(), ZONE) : null,
          completed: pickedStep ? clocksOf(pickedStep.at, ZONE) : null,
        },
      ],
      deliveries: [{ name: "Gary delivery", city: "Gary", state: "IN", apptFromLocal: null, apptToLocal: null, ...delivery }],
      stopCount: 2,
      legCount: 1,
      pickedUp: pickedStep ? clocksOf(pickedStep.at, ZONE) : null,
      delivered: deliveredStep ? clocksOf(deliveredStep.at, ZONE) : null,
      lastDeliveryCompleted: deliveredStep ? clocksOf(deliveredStep.at, ZONE) : null,
      revenueTotalCents: 150_000,
      driverPayTotalCents: null,
      updatedAt: last.at,
      finalizedAt: null,
      ...over,
    },
    history: steps.map((s, i) => ({
      externalId: `${externalId}:h${i}`,
      field: "status",
      newValue: s.label,
      previousValue: i === 0 ? null : steps[i - 1].label,
      changedBy: "Driver app",
      at: clocksOf(s.at, ZONE),
    })),
    documents: [
      {
        externalId: `${externalId}:d1`,
        fileName: "ratecon.pdf",
        typeLabel: "Rate Confirmation",
        shared: false,
        updatedAt: steps[0].at,
        byteLength: 40_000,
        uploaderKind: "office",
      },
      // A placeholder: an empty file is never mirrored.
      {
        externalId: `${externalId}:d0`,
        fileName: "pod.jpg",
        typeLabel: "Proof of Delivery",
        shared: true,
        updatedAt: steps[0].at,
        byteLength: 0,
        uploaderKind: "driver_app",
      },
    ],
    lines: [{ externalId: `${externalId}:l1`, group: "revenue", typeLabel: "Linehaul", description: "Linehaul", amountCents: 150_000 }],
  };
}

const T_TENDERED = "2026-10-31T21:00:00.000Z";
const T_PICKED = "2026-11-01T15:20:00.000Z";
const T_DELIVERED = "2026-11-02T16:30:00.000Z";

// ---------------------------------------------------------------------------------------------

let admin: Db;
let app: Db;
const made: Fixture[] = [];
let seq = 0;

type Carrier = Fixture & { token: string };

async function carrier(slug: string): Promise<Carrier> {
  const f = await makeTenant(admin, `${slug}-${randomUUID().slice(0, 8)}`);
  made.push(f);
  const token = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO tms_connections (id, tenant_id, system, label_map, lookback_hours, finalize_cooloff_minutes)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'synthetic', CAST($2 AS jsonb), 4, 30)`,
      [randomUUID(), JSON.stringify(syntheticLabelMap())],
    );
    await q.execute(
      `INSERT INTO desk_loops (tenant_id, lease_token, lease_until, updated_at)
       VALUES (current_tenant_id(), CAST($1 AS uuid), CAST('2026-11-02T19:00:00Z' AS timestamptz), CAST($2 AS timestamptz))`,
      [token, NOW.toISOString()],
    );
  });
  return { ...f, token };
}

async function ourLoad(f: Fixture, status = "in_transit"): Promise<{ id: string; number: string }> {
  seq += 1;
  const id = randomUUID();
  const number = `TS-L${10000 + seq}`;
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
         dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), $5, 'Joliet', 'IL',
         'Gary', 'IN', CAST('2026-11-01' AS date), 420, 150000)`,
      [id, number, f.customerId, f.driverId, status],
    ),
  );
  return { id, number };
}

// A minute of time to spare by a clock that stands still at `now`, so the deadline never comes.
const roomy = (now: Date) => ({ deadlineMs: now.getTime() + 60_000, clock: () => now.getTime() });
const pull = (f: Carrier, now: Date = NOW) => {
  const { deadlineMs, clock } = roomy(now);
  return pullTms(app, f.session, { token: f.token, now, deadlineMs }, { clock });
};

const countsOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, async (q) => {
    const out: Record<string, number> = {};
    for (const t of TABLES) {
      const [r] = await q.query<{ n: number }>(`SELECT CAST(count(*) AS integer) AS n FROM ${t} WHERE tenant_id = current_tenant_id()`);
      out[t] = r.n;
    }
    return out;
  });

const ts = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const mirrorOf = (f: Fixture, externalId: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<{
      id: string;
      load_id: string | null;
      status_code: string;
      read_attempts: number;
      source_updated_at: string;
      gone_at: string | null;
      flags: string[];
    }>(
      `SELECT CAST(id AS text) AS id, CAST(load_id AS text) AS load_id, status_code, read_attempts,
              ${ts("source_updated_at")} AS source_updated_at, ${ts("gone_at")} AS gone_at, flags
         FROM tms_loads WHERE tenant_id = current_tenant_id() AND external_id = $1`,
      [externalId],
    );
    return row;
  });

const walkOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<{ walk: { passStartedAt: string; below: unknown } | null }>(
      "SELECT watermarks->'tms_walk' AS walk FROM desk_loops WHERE tenant_id = current_tenant_id()",
    );
    return row?.walk ?? null;
  });

const eventIdOf = (f: Fixture, externalEventId: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<{ id: string }>(
      "SELECT CAST(id AS text) AS id FROM tms_status_events WHERE tenant_id = current_tenant_id() AND external_event_id = $1",
      [externalEventId],
    );
    return row?.id;
  });

const fromEvent = (f: Fixture, eventId: string) => app.withTenant(f.tenantId, (q) => moveFromTmsEvent(q, f.session, eventId, NOW));

const loadEventsOf = (f: Fixture, loadId: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ to_status: string; source: string; evidence_table: string | null; evidence_id: string | null; at: string }>(
      `SELECT to_status, source, evidence_table, CAST(evidence_id AS text) AS evidence_id, ${ts("at")} AS at
         FROM load_events WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid) ORDER BY at`,
      [loadId],
    ),
  );

const cardsOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ subject_id: string; args: Record<string, unknown> }>(
      `SELECT CAST(subject_id AS text) AS subject_id, args FROM proposals
        WHERE tenant_id = current_tenant_id() AND kind = 'load_move' ORDER BY created_at, id`,
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
  fake = new FakeTms();
  Object.assign(flags.tmsSync, savedTms, { enabled: true, startDate: "2026-10-31" });
  flags.loadMovement.enabled = true;
  flags.loadMovement.startDate = "2026-10-30";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(flags.tmsSync, savedTms);
  Object.assign(flags.loadMovement, savedMove);
  flags.deskLoop.enabled = savedDesk.enabled;
  flags.deskLoop.armed = savedDesk.armed;
  flags.deskLoop.startDate = savedDesk.startDate;
  vi.restoreAllMocks();
});

describe("0075's checks", () => {
  it("refuses an unknown status code, a bad local clock and a time with only one clock", async () => {
    const f = await carrier("tms-checks");
    const base = (over: string) =>
      admin.withTenant(f.tenantId, (q) =>
        q.execute(
          `INSERT INTO tms_loads (id, tenant_id, external_id, reference, status_code, status_label, stop_count, leg_count,
             source_updated_at, received_at, picked_up_local, picked_up_at, picked_up_day)
           VALUES (CAST($1 AS uuid), current_tenant_id(), $2, 'R-1', ${over})`,
          [randomUUID(), `x-${randomUUID().slice(0, 8)}`],
        ),
      );
    const fine = `'booked', 'Booked', 2, 1, now(), now(), '2026-11-01T09:20', now(), CAST('2026-11-01' AS date)`;
    expect(await sqlStateOf(base(fine))).toBe("no error");
    expect(await sqlStateOf(base(`'flying', 'Flying', 2, 1, now(), now(), NULL, NULL, NULL`))).toBe("23514");
    expect(await sqlStateOf(base(`'booked', 'Booked', 2, 1, now(), now(), '11/01 9:20', now(), CAST('2026-11-01' AS date)`))).toBe(
      "23514",
    );
    expect(await sqlStateOf(base(`'booked', 'Booked', 2, 1, now(), now(), '2026-11-01T09:20', NULL, NULL`))).toBe("23514");
  });

  it("lets a dispatch move name only a dispatch event as its evidence", async () => {
    const f = await carrier("tms-evidence");
    const l = await ourLoad(f);
    const insert = (source: string, table: string | null) =>
      admin.withTenant(f.tenantId, (q) =>
        q.execute(
          `INSERT INTO load_events (id, tenant_id, load_id, from_status, to_status, source, evidence_table, evidence_id, at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'in_transit', 'delivered', $3, $4,
                   CAST($5 AS uuid), now())`,
          [randomUUID(), l.id, source, table, table === null ? null : randomUUID()],
        ),
      );
    expect(await sqlStateOf(insert("tms", "documents"))).toBe("23514");
    expect(await sqlStateOf(insert("tms", null))).toBe("23514");
    expect(await sqlStateOf(insert("driver_photo", "tms_status_events"))).toBe("23514");
    expect(await sqlStateOf(insert("tms", "tms_status_events"))).toBe("no error");
  });

  it("never lets the app change a status event that happened", async () => {
    const f = await carrier("tms-noupdate");
    const l = await ourLoad(f);
    fake.loads.set("A-1", dispatchLoad("A-1", l.number, [{ label: LABEL.tendered, at: T_TENDERED }]));
    await pull(f);
    expect(
      await sqlStateOf(
        app.withTenant(f.tenantId, (q) => q.execute("UPDATE tms_status_events SET new_value = 'Delivered' WHERE tenant_id = current_tenant_id()")),
      ),
    ).toBe("42501");
  });
});

describe("the mirror's isolation", () => {
  it("shows another carrier none of a carrier's seven tables", async () => {
    const a = await carrier("tms-rls-a");
    const b = await carrier("tms-rls-b");
    const l = await ourLoad(a);
    fake.loads.set("A-1", dispatchLoad("A-1", l.number, [{ label: LABEL.tendered, at: T_TENDERED }, { label: LABEL.in_transit, at: T_PICKED }]));
    await pull(a);
    const mine = await app.withTenant(a.tenantId, async (q) => {
      const out: number[] = [];
      for (const t of TABLES) out.push((await q.query<{ n: number }>(`SELECT CAST(count(*) AS integer) AS n FROM ${t}`))[0].n);
      return out;
    });
    expect(mine.every((n) => n > 0)).toBe(true);
    const theirs = await app.withTenant(b.tenantId, async (q) => {
      const out: number[] = [];
      for (const t of TABLES) {
        out.push(
          (await q.query<{ n: number }>(`SELECT CAST(count(*) AS integer) AS n FROM ${t} WHERE tenant_id = CAST($1 AS uuid)`, [a.tenantId]))[0]
            .n,
        );
      }
      return out;
    });
    expect(theirs).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("the sync", () => {
  it("does nothing while switched off, and nothing without the desk's lease", async () => {
    const f = await carrier("tms-off");
    fake.loads.set("A-1", dispatchLoad("A-1", "R-1", [{ label: LABEL.tendered, at: T_TENDERED }]));
    flags.tmsSync.enabled = false;
    expect(await pull(f)).toEqual({ ran: false, category: "switched_off" });
    flags.tmsSync.enabled = true;
    expect(await pullTms(app, f.session, { token: randomUUID(), now: NOW, deadlineMs: roomy(NOW).deadlineMs }, { clock: roomy(NOW).clock })).toEqual({
      ran: false,
      category: "no_lease",
    });
    expect(fake.calls).toEqual([]);
    expect((await countsOf(f)).tms_loads).toBe(0);
  });

  it("walks every load once a pass by bookmark, and a second pass writes the same rows", async () => {
    const f = await carrier("tms-twice");
    for (let i = 0; i < 5; i += 1) {
      const at = new Date(Date.parse(T_TENDERED) + i * 60_000).toISOString();
      fake.loads.set(`A-${i}`, dispatchLoad(`A-${i}`, `R-${i}`, [{ label: LABEL.tendered, at }]));
    }
    flags.tmsSync.pageSize = 2;
    flags.tmsSync.maxPagesPerWake = 1;
    const first = await pull(f);
    expect(first).toMatchObject({ ran: true, listed: 2, read: 2, written: 2, passComplete: false });
    expect((await walkOf(f))?.below).toEqual({ createdAt: new Date(Date.parse(T_TENDERED) + 3 * 60_000).toISOString(), id: "A-3" });
    await pull(f, new Date(NOW.getTime() + 60_000));
    const third = await pull(f, new Date(NOW.getTime() + 120_000));
    expect(third).toMatchObject({ ran: true, passComplete: true });
    expect((await walkOf(f))?.below).toBeNull();
    const counts = await countsOf(f);
    expect(counts).toMatchObject({ tms_connections: 1, tms_loads: 5, tms_stops: 10, tms_status_events: 5, tms_line_items: 5, tms_documents: 5 });

    // A second whole pass with nothing changed: nothing read in full, the same rows, the same bookmark.
    fake.calls = [];
    for (let i = 0; i < 3; i += 1) await pull(f, new Date(NOW.getTime() + (3 + i) * 60_000));
    expect(fake.calls.filter((c) => c.startsWith("load:"))).toEqual([]);
    expect(await countsOf(f)).toEqual(counts);
    expect((await walkOf(f))?.below).toBeNull();
  });

  it("reads nothing once the deadline has come, and leaves the bookmark where it was", async () => {
    const f = await carrier("tms-late");
    for (let i = 0; i < 5; i += 1) {
      const at = new Date(Date.parse(T_TENDERED) + i * 60_000).toISOString();
      fake.loads.set(`A-${i}`, dispatchLoad(`A-${i}`, `R-${i}`, [{ label: LABEL.tendered, at }]));
    }
    flags.tmsSync.pageSize = 2;
    flags.tmsSync.maxPagesPerWake = 1;
    await pull(f);
    const bookmark = (await walkOf(f))?.below;
    expect(bookmark).toEqual({ createdAt: new Date(Date.parse(T_TENDERED) + 3 * 60_000).toISOString(), id: "A-3" });
    const counts = await countsOf(f);

    fake.calls = [];
    const late = new Date(NOW.getTime() + 60_000);
    const r = await pullTms(app, f.session, { token: f.token, now: late, deadlineMs: late.getTime() }, { clock: () => late.getTime() });
    expect(r).toMatchObject({ ran: true, listed: 0, read: 0, written: 0, passComplete: false, stopped: "deadline" });
    expect(fake.calls).toEqual([]);
    expect((await walkOf(f))?.below).toEqual(bookmark);
    expect(await countsOf(f)).toEqual(counts);
  });

  it("saves the walk when the deadline comes mid-page, keeps the bookmark, and the next pass resumes", async () => {
    const f = await carrier("tms-midpage");
    for (let i = 0; i < 5; i += 1) {
      const at = new Date(Date.parse(T_TENDERED) + i * 60_000).toISOString();
      fake.loads.set(`A-${i}`, dispatchLoad(`A-${i}`, `R-${i}`, [{ label: LABEL.tendered, at }]));
    }
    flags.tmsSync.pageSize = 2;
    flags.tmsSync.maxPagesPerWake = 1;
    await pull(f);
    const bookmark = (await walkOf(f))?.below;
    expect(bookmark).toMatchObject({ id: "A-3" });

    // Ten seconds go by with each full read, and the deadline is five seconds out: the page's first
    // load (A-2) is read, then time is up before the second (A-1).
    fake.calls = [];
    const at = new Date(NOW.getTime() + 60_000);
    const reads = () => fake.calls.filter((c) => c.startsWith("load:")).length;
    const r = await pullTms(
      app,
      f.session,
      { token: f.token, now: at, deadlineMs: at.getTime() + 5_000 },
      { clock: () => at.getTime() + reads() * 10_000 },
    );
    expect(r).toMatchObject({ ran: true, listed: 2, read: 1, written: 1, passComplete: false, stopped: "deadline" });
    expect(fake.calls).toEqual(["list", "load:A-2"]);
    expect((await walkOf(f))?.below).toEqual(bookmark);
    // The walk was saved by this run (the lease row's updated_at is its time).
    const [row] = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ updated_at: string }>(`SELECT ${ts("updated_at")} AS updated_at FROM desk_loops WHERE tenant_id = current_tenant_id()`),
    );
    expect(row.updated_at).toBe(at.toISOString());
    expect((await countsOf(f)).tms_loads).toBe(3);

    // The next pass lists the same page again: A-2 is mirrored already, so only A-1 is read.
    fake.calls = [];
    const next = await pull(f, new Date(NOW.getTime() + 120_000));
    expect(next).toMatchObject({ ran: true, listed: 2, read: 1, written: 1, stopped: null });
    expect(fake.calls).toEqual(["list", "load:A-1"]);
    expect((await walkOf(f))?.below).toEqual({ createdAt: new Date(Date.parse(T_TENDERED) + 60_000).toISOString(), id: "A-1" });
    const last = await pull(f, new Date(NOW.getTime() + 180_000));
    expect(last).toMatchObject({ ran: true, passComplete: true, stopped: null });
    expect((await countsOf(f)).tms_loads).toBe(5);
  });

  it("keeps one history row per event when pages repeat a row and the load is read again", async () => {
    const f = await carrier("tms-history");
    fake.repeatAcrossPages = true;
    const steps = [
      { label: LABEL.tendered, at: T_TENDERED },
      { label: "Booked", at: "2026-10-31T22:00:00.000Z" },
      { label: LABEL.in_transit, at: T_PICKED },
    ];
    fake.loads.set("A-1", dispatchLoad("A-1", "R-1", steps));
    await pull(f);
    expect((await countsOf(f)).tms_status_events).toBe(3);
    fake.loads.set("A-1", dispatchLoad("A-1", "R-1", [...steps, { label: LABEL.delivered, at: T_DELIVERED }]));
    await pull(f, new Date(NOW.getTime() + 60_000));
    expect((await countsOf(f)).tms_status_events).toBe(4);
  });

  it("mirrors no placeholder document, and maps the load's status and link by whole values", async () => {
    const f = await carrier("tms-docs");
    const l = await ourLoad(f);
    fake.loads.set("A-1", dispatchLoad("A-1", l.number, [{ label: LABEL.tendered, at: T_TENDERED }]));
    // A reference that merely contains ours is not ours.
    fake.loads.set("A-2", dispatchLoad("A-2", `${l.number}X`, [{ label: LABEL.tendered, at: T_TENDERED }]));
    await pull(f);
    const docs = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ external_id: string; doc_kind: string }>(
        "SELECT external_id, doc_kind FROM tms_documents WHERE tenant_id = current_tenant_id() ORDER BY external_id",
      ),
    );
    expect(docs).toEqual([
      { external_id: "A-1:d1", doc_kind: "rate_confirmation" },
      { external_id: "A-2:d1", doc_kind: "rate_confirmation" },
    ]);
    expect(await mirrorOf(f, "A-1")).toMatchObject({ load_id: l.id, status_code: "tendered", flags: [] });
    expect(await mirrorOf(f, "A-2")).toMatchObject({ load_id: null, flags: ["unlinked"] });
  });

  it("tombstones a load the dispatch system no longer has, once, with one card for our running load", async () => {
    const f = await carrier("tms-gone");
    const l = await ourLoad(f);
    fake.loads.set("A-1", dispatchLoad("A-1", l.number, [{ label: LABEL.tendered, at: T_TENDERED }, { label: LABEL.in_transit, at: T_PICKED }]));
    await pull(f);
    fake.loads.delete("A-1");
    const r = await pull(f, new Date(NOW.getTime() + 60_000));
    expect(r).toMatchObject({ ran: true, gone: 1 });
    const row = await mirrorOf(f, "A-1");
    expect(row.gone_at).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect((await countsOf(f)).tms_status_events).toBe(2);
    const cards = await cardsOf(f);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ subject_id: l.id });
    expect(JSON.stringify(cards[0].args)).toContain("tms_gone");

    // Never read again, never a second card.
    fake.calls = [];
    await pull(f, new Date(NOW.getTime() + 120_000));
    await pull(f, new Date(NOW.getTime() + 180_000));
    expect(fake.calls.filter((c) => c === "load:A-1")).toEqual([]);
    expect(await cardsOf(f)).toHaveLength(1);
  });

  it("leaves the mirror as it was on a read that throws, counts the attempt and rests at ten", async () => {
    const f = await carrier("tms-throw");
    fake.loads.set("A-1", dispatchLoad("A-1", "R-1", [{ label: LABEL.tendered, at: T_TENDERED }]));
    await pull(f);
    const before = await countsOf(f);
    const was = await mirrorOf(f, "A-1");
    fake.loads.set("A-1", dispatchLoad("A-1", "R-1", [{ label: LABEL.tendered, at: T_TENDERED }, { label: LABEL.in_transit, at: T_PICKED }]));
    fake.failing.add("A-1");
    let at = NOW.getTime();
    for (let i = 1; i <= 10; i += 1) {
      at += 60_000;
      const r = await pull(f, new Date(at));
      expect(r).toMatchObject({ ran: true, failed: 1, written: 0 });
      const row = await mirrorOf(f, "A-1");
      expect(row.read_attempts).toBe(i);
      expect(row.source_updated_at).toBe(was.source_updated_at);
      expect(row.status_code).toBe("tendered");
    }
    expect(await countsOf(f)).toEqual(before);
    expect((await mirrorOf(f, "A-1")).flags).toContain("read_failed");

    // Resting: not read again until its updatedAt moves.
    fake.calls = [];
    await pull(f, new Date((at += 60_000)));
    expect(fake.calls.filter((c) => c === "load:A-1")).toEqual([]);
    fake.failing.delete("A-1");
    fake.loads.set(
      "A-1",
      dispatchLoad("A-1", "R-1", [
        { label: LABEL.tendered, at: T_TENDERED },
        { label: LABEL.in_transit, at: T_PICKED },
        { label: LABEL.delivered, at: T_DELIVERED },
      ]),
    );
    await pull(f, new Date((at += 60_000)));
    const row = await mirrorOf(f, "A-1");
    expect(row).toMatchObject({ read_attempts: 0, status_code: "delivered", source_updated_at: T_DELIVERED });
    expect(row.flags).not.toContain("read_failed");
  });

  it("runs Sync dispatch now under the desk's lease, and is busy while a wake holds it", async () => {
    const f = await carrier("tms-now");
    fake.loads.set("A-1", dispatchLoad("A-1", "R-1", [{ label: LABEL.tendered, at: T_TENDERED }]));
    // The carrier's lease (from carrier()) runs until 19:00.
    expect(await syncDispatchNow(app, f.session, NOW)).toEqual({ ok: false, category: "busy" });
    const later = new Date("2026-11-02T19:30:00.000Z");
    const r = await syncDispatchNow(app, f.session, later);
    expect(r).toMatchObject({ ok: true, result: { ran: true, written: 1 } });
    const lease = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ lease_token: string | null }>("SELECT CAST(lease_token AS text) AS lease_token FROM desk_loops WHERE tenant_id = current_tenant_id()"),
    );
    expect(lease[0].lease_token).toBeNull();
  });
});

describe("a dispatch event moves our load", () => {
  async function delivered(f: Carrier, ourStatus = "in_transit") {
    const l = await ourLoad(f, ourStatus);
    fake.loads.set(
      "A-1",
      dispatchLoad("A-1", l.number, [
        { label: LABEL.tendered, at: T_TENDERED },
        { label: LABEL.in_transit, at: T_PICKED },
        { label: LABEL.delivered, at: T_DELIVERED },
      ]),
    );
    await pull(f);
    const eventId = await eventIdOf(f, "A-1:h2");
    if (!eventId) throw new Error("no event");
    return { l, eventId };
  }

  it("moves an in transit load to delivered at the stop's time, one load_events row, and again writes none", async () => {
    const f = await carrier("tms-move");
    const { l, eventId } = await delivered(f);
    expect(await fromEvent(f, eventId)).toMatchObject({ kind: "moved", loadId: l.id });
    const state = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ status: string; delivered_on: string; delivered_at: string; delivery_arrived_at: string; delivery_departed_at: string }>(
        `SELECT status, to_char(delivered_on, 'YYYY-MM-DD') AS delivered_on, ${ts("delivered_at")} AS delivered_at,
                ${ts("delivery_arrived_at")} AS delivery_arrived_at, ${ts("delivery_departed_at")} AS delivery_departed_at
           FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [l.id],
      ),
    );
    expect(state[0]).toEqual({
      status: "delivered",
      delivered_on: "2026-11-02",
      delivered_at: T_DELIVERED,
      delivery_arrived_at: "2026-11-02T15:30:00.000Z",
      delivery_departed_at: T_DELIVERED,
    });
    expect(await loadEventsOf(f, l.id)).toEqual([
      { to_status: "delivered", source: "tms", evidence_table: "tms_status_events", evidence_id: eventId, at: T_DELIVERED },
    ]);
    expect(await fromEvent(f, eventId)).toMatchObject({ kind: "already" });
    expect(await loadEventsOf(f, l.id)).toHaveLength(1);
  });

  it("moves nothing for an event before the sync's start date", async () => {
    const f = await carrier("tms-before");
    const { l, eventId } = await delivered(f);
    flags.tmsSync.startDate = "2026-11-05";
    expect(await fromEvent(f, eventId)).toEqual({ kind: "nothing", category: "before_start" });
    expect(await loadEventsOf(f, l.id)).toEqual([]);
  });

  it("moves nothing while load movement is off", async () => {
    const f = await carrier("tms-moveoff");
    const { l, eventId } = await delivered(f);
    flags.loadMovement.enabled = false;
    expect(await fromEvent(f, eventId)).toEqual({ kind: "nothing", category: "switched_off" });
    expect(await loadEventsOf(f, l.id)).toEqual([]);
  });

  it("makes one card when the dispatch system cancels a load we still run", async () => {
    const f = await carrier("tms-withdrawn");
    const l = await ourLoad(f);
    fake.loads.set(
      "A-1",
      dispatchLoad("A-1", l.number, [
        { label: LABEL.tendered, at: T_TENDERED },
        { label: LABEL.cancelled, at: T_PICKED },
      ]),
    );
    await pull(f);
    const eventId = await eventIdOf(f, "A-1:h1");
    if (!eventId) throw new Error("no event");
    await fromEvent(f, eventId);
    await fromEvent(f, eventId);
    const cards = await cardsOf(f);
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0].args)).toContain("tms_withdrawn");
    expect(await loadEventsOf(f, l.id)).toEqual([]);
  });

  it("makes no card for an event on a load that is not ours", async () => {
    const f = await carrier("tms-unlinked");
    fake.loads.set(
      "A-1",
      dispatchLoad("A-1", "NOT-OURS", [
        { label: LABEL.tendered, at: T_TENDERED },
        { label: LABEL.in_transit, at: T_PICKED },
      ]),
    );
    await pull(f);
    const eventId = await eventIdOf(f, "A-1:h1");
    if (!eventId) throw new Error("no event");
    expect(await fromEvent(f, eventId)).toEqual({ kind: "nothing", category: "unlinked" });
    expect(await cardsOf(f)).toEqual([]);
  });
});

describe("the desk's dispatch lane", () => {
  it("works each new status event once, never a seeded one, and finds none while the sync is off", async () => {
    const f = await carrier("tms-desk");
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@tms-test.invalid', 'staff')`,
      ),
    );
    // The desk takes its own lease.
    await admin.withTenant(f.tenantId, (q) =>
      q.execute("UPDATE desk_loops SET lease_token = NULL, lease_until = NULL WHERE tenant_id = current_tenant_id()"),
    );
    const service = await serviceSession(app, f.tenantId);
    if (!service) throw new Error("no service login");
    flags.deskLoop.enabled = true;
    flags.deskLoop.armed = true;
    flags.deskLoop.startDate = "2026-10-30";

    const l = await ourLoad(f);
    fake.loads.set(
      "A-1",
      dispatchLoad("A-1", l.number, [
        { label: LABEL.tendered, at: T_TENDERED },
        { label: LABEL.in_transit, at: T_PICKED },
        { label: LABEL.delivered, at: T_DELIVERED },
      ]),
    );

    const real = deskHandlers({ db: app });
    const runs: string[] = [];
    const handlers = {} as Handlers;
    for (const source of DESK_SOURCES) {
      handlers[source] =
        source === "tms_event"
          ? {
              ...real.tms_event,
              run: (s, e, ctx) => {
                runs.push(e.eventKey);
                return real.tms_event.run(s, e, ctx);
              },
            }
          : { switchOn: () => true, needsMs: 1_000, run: async () => ({ outcome: "done", detail: { found: 0 } }) };
    }
    let now = NOW.getTime();
    const wake = () =>
      wakeDesk(
        service,
        { wakeId: randomUUID(), by: "schedule", deadlineMs: now + 25_000 },
        { db: app, clock: () => new Date(now), handlers, newId: randomUUID, log: () => {} },
      );

    // Off: the sync reads nothing and the finder finds nothing.
    flags.tmsSync.enabled = false;
    await wake();
    expect(fake.calls).toEqual([]);
    expect(runs).toEqual([]);

    // On: the wake's own pull mirrors the load, then the desk works its three status events once.
    flags.tmsSync.enabled = true;
    now += 20 * 60_000;
    await wake();
    const ids = await Promise.all(["A-1:h0", "A-1:h1", "A-1:h2"].map((x) => eventIdOf(f, x)));
    expect(runs.sort()).toEqual(ids.map((id) => eventKey("tms_event", id as string)).sort());
    expect((await loadEventsOf(f, l.id)).map((e) => e.to_status)).toEqual(["delivered"]);

    // A seeded event is never worked; nothing is worked twice.
    const mirror = await mirrorOf(f, "A-1");
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `INSERT INTO tms_status_events (id, tenant_id, tms_load_id, external_event_id, field, new_value, at_local, at, day,
           received_at, seeded)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'A-1:seeded', 'status', 'Delivered',
           '2026-11-02T10:30', CAST($3 AS timestamptz), CAST('2026-11-02' AS date), CAST($4 AS timestamptz), true)`,
        [randomUUID(), mirror.id, T_DELIVERED, new Date(now + 60_000).toISOString()],
      ),
    );
    runs.length = 0;
    now += 20 * 60_000;
    await wake();
    expect(runs).toEqual([]);
    expect(await loadEventsOf(f, l.id)).toHaveLength(1);
  });

  it("runs a planned load's in transit and delivered events of one pass in event order: delivered, no card", async () => {
    const f = await carrier("tms-order");
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@tms-test.invalid', 'staff')`,
      ),
    );
    const l = await ourLoad(f, "planned");
    fake.loads.set(
      "A-1",
      dispatchLoad("A-1", l.number, [
        { label: LABEL.tendered, at: T_TENDERED },
        { label: LABEL.in_transit, at: T_PICKED },
        { label: LABEL.delivered, at: T_DELIVERED },
      ]),
    );
    // One pass mirrors both moves with the same received_at. Ids that fall as rows are written put
    // the delivered event's key before the in transit one's, the order that used to run it first.
    let n = 0;
    const falling = () => {
      n += 1;
      return `${(0xf0000000 - n).toString(16)}-${randomUUID().slice(9)}`;
    };
    expect(
      await pullTms(app, f.session, { token: f.token, now: NOW, deadlineMs: roomy(NOW).deadlineMs }, { newId: falling, clock: roomy(NOW).clock }),
    ).toMatchObject({ ran: true, written: 1 });
    const pickedId = await eventIdOf(f, "A-1:h1");
    const deliveredId = await eventIdOf(f, "A-1:h2");
    if (!pickedId || !deliveredId) throw new Error("no events");
    const pickedKey = eventKey("tms_event", pickedId);
    const deliveredKey = eventKey("tms_event", deliveredId);
    expect(deliveredKey < pickedKey).toBe(true);

    // The desk takes its own lease.
    await admin.withTenant(f.tenantId, (q) =>
      q.execute("UPDATE desk_loops SET lease_token = NULL, lease_until = NULL WHERE tenant_id = current_tenant_id()"),
    );
    const service = await serviceSession(app, f.tenantId);
    if (!service) throw new Error("no service login");
    flags.deskLoop.enabled = true;
    flags.deskLoop.armed = true;
    flags.deskLoop.startDate = "2026-10-30";
    const real = deskHandlers({ db: app });
    const runs: string[] = [];
    const handlers = {} as Handlers;
    for (const source of DESK_SOURCES) {
      handlers[source] =
        source === "tms_event"
          ? {
              ...real.tms_event,
              run: (s, e, ctx) => {
                runs.push(e.eventKey);
                return real.tms_event.run(s, e, ctx);
              },
            }
          : { switchOn: () => true, needsMs: 1_000, run: async () => ({ outcome: "done", detail: { found: 0 } }) };
    }
    const now = NOW.getTime() + 20 * 60_000;
    await wakeDesk(
      service,
      { wakeId: randomUUID(), by: "schedule", deadlineMs: now + 25_000 },
      { db: app, clock: () => new Date(now), handlers, newId: randomUUID, log: () => {} },
    );

    expect(runs.indexOf(pickedKey)).toBeGreaterThanOrEqual(0);
    expect(runs.indexOf(pickedKey)).toBeLessThan(runs.indexOf(deliveredKey));
    expect((await loadEventsOf(f, l.id)).map((e) => e.to_status)).toEqual(["in_transit", "delivered"]);
    const [state] = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ status: string; proposals: number; asks: number }>(
        `SELECT status,
                (SELECT CAST(count(*) AS integer) FROM proposals p WHERE p.tenant_id = current_tenant_id()) AS proposals,
                (SELECT CAST(count(*) AS integer) FROM agent_asks a WHERE a.tenant_id = current_tenant_id()) AS asks
           FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [l.id],
      ),
    );
    expect(state).toEqual({ status: "delivered", proposals: 0, asks: 0 });
  });
});
