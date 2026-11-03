import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import type { ReadComplete } from "../documents/read";
import { CONFIDENCE_FIELDS } from "../documents/types";
import { addJudge, dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { syntheticLabelMap } from "../tms/status";
import { sendDriverPaperwork, type PaperStage } from "./paperwork";

// The driver's phone against a fresh database, as the app's role: the rendered paper goes through
// the real document pipeline with a stand-in reader (ServiceDeps read.complete, never the model),
// our load moves by the paperwork rules, and the sample board's stop is completed after it. Fixed
// clocks only (never the wall clock). Only this file's carriers are made, removed after, failures too.

const demo = vi.hoisted(() => ({ on: true }));
vi.mock("../seed/reset", async (importOriginal) => {
  const real = await importOriginal<typeof import("../seed/reset")>();
  return { ...real, demoCarrierOf: async () => (demo.on ? ({ slug: "test" } as unknown as Awaited<ReturnType<typeof real.demoCarrierOf>>) : null) };
});

const saved = {
  paper: structuredClone(flags.driverPaperwork),
  mock: structuredClone(flags.mockTms),
  move: structuredClone(flags.loadMovement),
  judge: structuredClone(flags.judgeAccess),
  documents: flags.documentsEnabled,
};

// Tuesday Nov 3, 2026, 9:00 CST (makeTenant's carriers are America/Chicago).
const T0 = Date.parse("2026-11-03T15:00:00.000Z");
const HOUR = 3_600_000;

let admin: Db;
let app: Db;
const made: Fixture[] = [];
let seq = 0;

async function carrier(): Promise<Fixture> {
  const f = await makeTenant(admin, `paper-${randomUUID().slice(0, 8)}`);
  made.push(f);
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO tms_connections (id, tenant_id, system, label_map, lookback_hours, finalize_cooloff_minutes, demo_faults)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'mock', CAST($2 AS jsonb), 4, 2, CAST('{}' AS jsonb))`,
      [randomUUID(), JSON.stringify(syntheticLabelMap())],
    );
    await q.execute(
      `INSERT INTO mock_tms_parties (id, tenant_id, kind, external_id, name)
       VALUES (gen_random_uuid(), current_tenant_id(), 'driver', 'drv-1', 'Sample Driver One')`,
    );
  });
  return f;
}

// Our planned load and the board's load by the same number, picking up today.
async function load(f: Fixture): Promise<{ reference: string; ourId: string }> {
  seq += 1;
  const reference = `PW-L${30000 + seq}`;
  const ourId = randomUUID();
  const mockId = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
         dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), 'planned', 'Joliet', 'IL',
         'Gary', 'IN', CAST('2026-11-03' AS date), 420, 150000)`,
      [ourId, reference, f.customerId, f.driverId],
    );
    await q.execute(
      `INSERT INTO mock_tms_loads (id, tenant_id, external_id, reference, status_label, customer_external_id, customer_name,
         driver_external_id, truck_unit, created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, 'Booked', 'cus-1', 'Sample Shipper', 'drv-1', '101',
               CAST($4 AS timestamptz), CAST($5 AS timestamptz))`,
      [mockId, `syn:${reference}`, reference, new Date(T0 - 3 * HOUR).toISOString(), new Date(T0 - 2 * HOUR).toISOString()],
    );
    await q.execute(
      `INSERT INTO mock_tms_stops (id, tenant_id, mock_load_id, ordinal, stop_kind, name, city, state, appt_from_local, appt_to_local)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 0, 'pickup', 'Sample Dock', 'Joliet', 'IL',
               '2026-11-03T07:00', '2026-11-03T09:00'),
              (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 1, 'delivery', 'Sample Yard', 'Gary', 'IN',
               '2026-11-03T13:00', '2026-11-03T16:00')`,
      [mockId],
    );
    await q.execute(
      `INSERT INTO mock_tms_events (id, tenant_id, mock_load_id, seq, external_id, field, new_value, previous_value, changed_by, at)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 1, $2, 'status', 'Booked', NULL, 'Dispatch desk',
               CAST($3 AS timestamptz))`,
      [mockId, `syn:${reference}:e1`, new Date(T0 - 2 * HOUR).toISOString()],
    );
  });
  return { reference, ourId };
}

// What a faithful read of the paper says: the whole load number, its one date and its one stop.
function reading(reference: string, stage: PaperStage, stop: { arrived: string; departed: string }): string {
  return JSON.stringify({
    document_kind: "bill_of_lading",
    sample_word: true,
    vendor: null,
    date_mmddyyyy: "11/03/2026",
    total_cents: null,
    load_number: reference,
    truck_unit: null,
    gallons_milli: null,
    price_cents: null,
    loaded_miles: null,
    rate_per_mile_cents: null,
    linehaul_cents: null,
    fuel_surcharge_cents: null,
    customer_name: "Test Shipper",
    stops: [{ role: stage, ...stop }],
    text_lines: ["SAMPLE", "Bill of Lading", `Load ${reference}`],
    confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])),
  });
}

const PICKUP_STOP = { arrived: "11/03/2026 7:40 AM CST", departed: "11/03/2026 8:05 AM CST" };
const DELIVERY_STOP = { arrived: "11/03/2026 1:50 PM CST", departed: "11/03/2026 2:14 PM CST" };

function reader(text: string) {
  return vi.fn<ReadComplete>(
    async () =>
      ({
        callId: randomUUID(),
        status: "ok",
        text,
        toolCalls: [],
        usage: { input: 900, cached: 0, output: 300, reasoning: 0 },
        costNanocents: 1_500_000,
        upstreamId: null,
        replay: [],
        toolSearches: 0,
      }) satisfies AiResult,
  );
}

const tap = (session: Session, reference: string, stage: PaperStage, complete: ReadComplete, nowMs = T0) =>
  sendDriverPaperwork(session, { reference, stage }, { db: app, now: () => new Date(nowMs), read: { complete }, steady: () => 0 });

const ts = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const ours = (f: Fixture, id: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<{ status: string; pickup_departed_at: string | null; delivered_at: string | null }>(
      `SELECT status, ${ts("pickup_departed_at")} AS pickup_departed_at, ${ts("delivered_at")} AS delivered_at
         FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id],
    );
    return row;
  });

const eventsOf = (f: Fixture, id: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ to_status: string; evidence_table: string | null; evidence_id: string | null }>(
      `SELECT to_status, evidence_table, CAST(evidence_id AS text) AS evidence_id FROM load_events
        WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid) ORDER BY at`,
      [id],
    ),
  );

const boardOf = (f: Fixture, reference: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const events = await q.query<{ field: string; new_value: string | null; changed_by: string | null }>(
      `SELECT e.field, e.new_value, e.changed_by FROM mock_tms_events e
         JOIN mock_tms_loads l ON l.tenant_id = e.tenant_id AND l.id = e.mock_load_id
        WHERE e.tenant_id = current_tenant_id() AND l.reference = $1 ORDER BY e.seq`,
      [reference],
    );
    const [load] = await q.query<{ status_label: string; pods: number }>(
      `SELECT l.status_label, CAST((SELECT count(*) FROM mock_tms_documents d
                WHERE d.tenant_id = l.tenant_id AND d.mock_load_id = l.id) AS integer) AS pods
         FROM mock_tms_loads l WHERE l.tenant_id = current_tenant_id() AND l.reference = $1`,
      [reference],
    );
    const stops = await q.query<{ stop_kind: string; arrived_at: string | null; completed_at: string | null }>(
      `SELECT s.stop_kind, ${ts("s.arrived_at")} AS arrived_at, ${ts("s.completed_at")} AS completed_at FROM mock_tms_stops s
         JOIN mock_tms_loads l ON l.tenant_id = s.tenant_id AND l.id = s.mock_load_id
        WHERE s.tenant_id = current_tenant_id() AND l.reference = $1 ORDER BY s.ordinal`,
      [reference],
    );
    return { events, status: load.status_label, pods: load.pods, stops };
  });

const documentsOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ id: string; filename: string; read_status: string }>(
      `SELECT CAST(id AS text) AS id, filename, read_status FROM documents WHERE tenant_id = current_tenant_id() ORDER BY created_at, id`,
    ),
  );

// A live visit for this judge with this many turns used, and its turns now.
async function visitOf(f: Fixture, judge: Session, turns: number): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO demo_sessions (id, tenant_id, cognito_sub, created_at, last_seen_at, expires_at, turns)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS timestamptz), CAST($3 AS timestamptz), CAST($4 AS timestamptz), $5)`,
      [id, judge.sub, new Date(T0 - HOUR).toISOString(), new Date(T0 + 23 * HOUR).toISOString(), turns],
    ),
  );
  return id;
}

const visitTurns = (f: Fixture, id: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [r] = await q.query<{ turns: number }>("SELECT turns FROM demo_sessions WHERE id = CAST($1 AS uuid)", [id]);
    return Number(r.turns);
  });

const MINUTE = 60_000;

beforeAll(() => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl(), max: 2 });
});

beforeEach(() => {
  demo.on = true;
  flags.driverPaperwork = { enabled: true, startDate: "2026-11-03", perDay: 30 };
  flags.mockTms = { ...saved.mock, enabled: true };
  flags.loadMovement = { ...saved.move, enabled: true, startDate: "2026-10-30" };
  flags.judgeAccess = { ...saved.judge, enabled: true };
  flags.documentsEnabled = true;
});

afterEach(() => {
  flags.driverPaperwork = structuredClone(saved.paper);
  flags.mockTms = structuredClone(saved.mock);
  flags.loadMovement = structuredClone(saved.move);
  flags.judgeAccess = structuredClone(saved.judge);
  flags.documentsEnabled = saved.documents;
});

afterAll(async () => {
  try {
    for (const f of made) await dropTenant(admin, f);
  } finally {
    await app?.close();
    await admin?.close();
  }
});

describe("driver sends paperwork", () => {
  it("reads the pickup paper, moves our load to in transit and completes the pickup on the board", async () => {
    const f = await carrier();
    const l = await load(f);
    const complete = reader(reading(l.reference, "pickup", PICKUP_STOP));
    const out = await tap(f.session, l.reference, "pickup", complete);
    expect(out).toEqual({
      kind: "moved",
      stage: "pickup",
      loadNumber: l.reference,
      driverFirstName: "Test",
      to: "in_transit",
      atLocal: "2026-11-03T08:05",
      board: "moved",
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const docs = await documentsOf(f);
    expect(docs).toEqual([{ id: expect.any(String), filename: `driver-${l.reference}-pickup.pdf`, read_status: "read" }]);
    expect(await ours(f, l.ourId)).toMatchObject({ status: "in_transit", pickup_departed_at: "2026-11-03T14:05:00.000Z" });
    expect(await eventsOf(f, l.ourId)).toEqual([{ to_status: "in_transit", evidence_table: "documents", evidence_id: docs[0].id }]);
    const board = await boardOf(f, l.reference);
    expect(board.status).toBe("In Transit");
    expect(board.events.slice(1)).toEqual([{ field: "status", new_value: "In Transit", changed_by: "LedgerLine (driver paperwork)" }]);
    expect(board.stops[0]).toEqual({ stop_kind: "pickup", arrived_at: "2026-11-03T13:40:00.000Z", completed_at: "2026-11-03T14:05:00.000Z" });
  });

  it("then reads the delivery paper, delivers our load and completes the delivery on the board with its proof", async () => {
    const f = await carrier();
    const l = await load(f);
    await tap(f.session, l.reference, "pickup", reader(reading(l.reference, "pickup", PICKUP_STOP)));
    const complete = reader(reading(l.reference, "delivery", DELIVERY_STOP));
    const out = await tap(f.session, l.reference, "delivery", complete, T0 + 6 * HOUR);
    expect(out).toMatchObject({ kind: "moved", stage: "delivery", to: "delivered", atLocal: "2026-11-03T14:14", board: "moved" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await ours(f, l.ourId)).toMatchObject({ status: "delivered", delivered_at: "2026-11-03T20:14:00.000Z" });
    expect((await eventsOf(f, l.ourId)).map((e) => e.to_status)).toEqual(["in_transit", "delivered"]);
    const board = await boardOf(f, l.reference);
    expect(board.status).toBe("Delivered");
    expect(board.pods).toBe(1);
    expect(board.events.at(-1)).toEqual({ field: "status", new_value: "Delivered", changed_by: "LedgerLine (driver paperwork)" });
  });

  it("refuses a repeat tap after the move before any read, and adds nothing to the board", async () => {
    const f = await carrier();
    const l = await load(f);
    await tap(f.session, l.reference, "pickup", reader(reading(l.reference, "pickup", PICKUP_STOP)));
    const before = await boardOf(f, l.reference);
    const again = reader(reading(l.reference, "pickup", PICKUP_STOP));
    expect(await tap(f.session, l.reference, "pickup", again)).toEqual({ kind: "refused", category: "wrong_stage" });
    expect(again).not.toHaveBeenCalled();
    expect((await boardOf(f, l.reference)).events).toEqual(before.events);
    expect(await documentsOf(f)).toHaveLength(1);
  });

  it("sends the same file on a repeat tap, read once, and moves on it once moves are on", async () => {
    const f = await carrier();
    const l = await load(f);
    flags.loadMovement = { ...flags.loadMovement, enabled: false };
    const complete = reader(reading(l.reference, "pickup", PICKUP_STOP));
    expect(await tap(f.session, l.reference, "pickup", complete)).toEqual({ kind: "refused", category: "moves_off" });
    expect((await ours(f, l.ourId)).status).toBe("planned");
    expect((await boardOf(f, l.reference)).events).toHaveLength(1);
    flags.loadMovement = { ...flags.loadMovement, enabled: true };
    const out = await tap(f.session, l.reference, "pickup", complete, T0 + 60_000);
    expect(out).toMatchObject({ kind: "moved", to: "in_transit", board: "moved" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await documentsOf(f)).toHaveLength(1);
    expect(await eventsOf(f, l.ourId)).toHaveLength(1);
  });

  it("moves nothing on a paper read as another load's", async () => {
    const f = await carrier();
    const l = await load(f);
    const complete = reader(reading("PW-L99999", "pickup", PICKUP_STOP));
    expect(await tap(f.session, l.reference, "pickup", complete)).toEqual({ kind: "refused", category: "not_matched" });
    expect((await ours(f, l.ourId)).status).toBe("planned");
    expect(await eventsOf(f, l.ourId)).toEqual([]);
    expect((await boardOf(f, l.reference)).events).toHaveLength(1);
  });

  it("moves nothing on a read that did not finish", async () => {
    const f = await carrier();
    const l = await load(f);
    const complete = vi.fn<ReadComplete>(async () => {
      throw new AiError("timeout");
    });
    expect(await tap(f.session, l.reference, "pickup", complete)).toEqual({ kind: "refused", category: "not_read" });
    expect((await ours(f, l.ourId)).status).toBe("planned");
    expect((await boardOf(f, l.reference)).events).toHaveLength(1);
  });

  it("writes nothing with the switch off, nor on a carrier that is not a demo carrier", async () => {
    const f = await carrier();
    const l = await load(f);
    const complete = reader(reading(l.reference, "pickup", PICKUP_STOP));
    flags.driverPaperwork = { ...flags.driverPaperwork, enabled: false };
    expect(await tap(f.session, l.reference, "pickup", complete)).toEqual({ kind: "refused", category: "disabled" });
    flags.driverPaperwork = { ...flags.driverPaperwork, enabled: true };
    demo.on = false;
    expect(await tap(f.session, l.reference, "pickup", complete)).toEqual({ kind: "refused", category: "not_demo" });
    expect(complete).not.toHaveBeenCalled();
    expect(await documentsOf(f)).toEqual([]);
    expect((await ours(f, l.ourId)).status).toBe("planned");
  });

  it("keeps our move and leaves the board untouched when the carrier is not on the sample system", async () => {
    const f = await carrier();
    const l = await load(f);
    await admin.withTenant(f.tenantId, (q) => q.execute("UPDATE tms_connections SET system = 'synthetic' WHERE tenant_id = current_tenant_id()"));
    const out = await tap(f.session, l.reference, "pickup", reader(reading(l.reference, "pickup", PICKUP_STOP)));
    expect(out).toMatchObject({ kind: "moved", to: "in_transit", board: "not_found" });
    expect((await ours(f, l.ourId)).status).toBe("in_transit");
    const board = await boardOf(f, l.reference);
    expect(board.events).toHaveLength(1);
    expect(board.status).toBe("Booked");
    expect(board.stops.every((s) => s.completed_at === null)).toBe(true);
  });

  it("refuses at the day's cap before any read", async () => {
    const f = await carrier();
    const l = await load(f);
    const other = await load(f);
    flags.driverPaperwork = { ...flags.driverPaperwork, perDay: 1 };
    await tap(f.session, l.reference, "pickup", reader(reading(l.reference, "pickup", PICKUP_STOP)));
    const complete = reader(reading(other.reference, "pickup", PICKUP_STOP));
    expect(await tap(f.session, other.reference, "pickup", complete)).toEqual({ kind: "refused", category: "cap" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("counts one visit turn per tap for a judge, and refuses a visit with no turns left before the read", async () => {
    const f = await carrier();
    const l = await load(f);
    const judge = await addJudge(admin, f);
    const visit = async (turns: number) => {
      const id = randomUUID();
      await admin.withTenant(f.tenantId, (q) =>
        q.execute(
          `INSERT INTO demo_sessions (id, tenant_id, cognito_sub, created_at, last_seen_at, expires_at, turns)
           VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS timestamptz), CAST($3 AS timestamptz), CAST($4 AS timestamptz), $5)`,
          [id, judge.sub, new Date(T0 - HOUR).toISOString(), new Date(T0 + 23 * HOUR).toISOString(), turns],
        ),
      );
      return id;
    };
    const turnsOf = (id: string) =>
      admin.withTenant(f.tenantId, async (q) => {
        const [r] = await q.query<{ turns: number }>("SELECT turns FROM demo_sessions WHERE id = CAST($1 AS uuid)", [id]);
        return r.turns;
      });

    const used = await visit(flags.judgeAccess.turnsPerSession);
    const refusedRead = reader(reading(l.reference, "pickup", PICKUP_STOP));
    expect(await tap({ ...judge, demoSessionId: used }, l.reference, "pickup", refusedRead)).toEqual({ kind: "refused", category: "visit_used" });
    expect(await tap(judge, l.reference, "pickup", refusedRead)).toEqual({ kind: "refused", category: "visit_ended" });
    expect(refusedRead).not.toHaveBeenCalled();
    expect(await documentsOf(f)).toEqual([]);
    expect(await turnsOf(used)).toBe(flags.judgeAccess.turnsPerSession);

    const live = await visit(0);
    const out = await tap({ ...judge, demoSessionId: live }, l.reference, "pickup", reader(reading(l.reference, "pickup", PICKUP_STOP)));
    expect(out).toMatchObject({ kind: "moved", to: "in_transit", board: "moved" });
    expect(await turnsOf(live)).toBe(1);
  });

  it("reads a stalled paper again on a later tap, and a tap while its read may still run costs no turn", async () => {
    const f = await carrier();
    const l = await load(f);
    const judge = await addJudge(admin, f);
    const visit = await visitOf(f, judge, 0);
    const me = { ...judge, demoSessionId: visit };
    const lost = vi.fn<ReadComplete>(async () => {
      throw new AiError("timeout");
    });
    expect(await tap(me, l.reference, "pickup", lost)).toEqual({ kind: "refused", category: "not_read" });
    expect(await visitTurns(f, visit)).toBe(1);
    const [doc] = await documentsOf(f);
    expect(doc.read_status).toBe("pending");

    // Thirty seconds on, the first read may still be running: no second read and no turn.
    const early = reader(reading(l.reference, "pickup", PICKUP_STOP));
    expect(await tap(me, l.reference, "pickup", early, T0 + 30_000)).toEqual({ kind: "refused", category: "not_read" });
    expect(early).not.toHaveBeenCalled();
    expect(await visitTurns(f, visit)).toBe(1);

    // Past the stalled time, the same paper is read again under Read again's claim and moves.
    const late = reader(reading(l.reference, "pickup", PICKUP_STOP));
    expect(await tap(me, l.reference, "pickup", late, T0 + 3 * MINUTE)).toMatchObject({ kind: "moved", to: "in_transit", board: "moved" });
    expect(late).toHaveBeenCalledTimes(1);
    expect(await visitTurns(f, visit)).toBe(2);
    expect(await documentsOf(f)).toEqual([{ id: doc.id, filename: doc.filename, read_status: "read" }]);
    expect(await eventsOf(f, l.ourId)).toEqual([{ to_status: "in_transit", evidence_table: "documents", evidence_id: doc.id }]);
  });

  it("leaves a stalled paper with no reads left unread, at no turn", async () => {
    const f = await carrier();
    const l = await load(f);
    const lost = vi.fn<ReadComplete>(async () => {
      throw new AiError("timeout");
    });
    expect(await tap(f.session, l.reference, "pickup", lost)).toEqual({ kind: "refused", category: "not_read" });
    expect(await tap(f.session, l.reference, "pickup", lost, T0 + 3 * MINUTE)).toEqual({ kind: "refused", category: "not_read" });
    expect(await tap(f.session, l.reference, "pickup", lost, T0 + 6 * MINUTE)).toEqual({ kind: "refused", category: "not_read" });
    expect(lost).toHaveBeenCalledTimes(3);
    const judge = await addJudge(admin, f);
    const visit = await visitOf(f, judge, 0);
    const last = reader(reading(l.reference, "pickup", PICKUP_STOP));
    expect(await tap({ ...judge, demoSessionId: visit }, l.reference, "pickup", last, T0 + 9 * MINUTE)).toEqual({
      kind: "refused",
      category: "not_read",
    });
    expect(last).not.toHaveBeenCalled();
    expect(await visitTurns(f, visit)).toBe(0);
    expect((await ours(f, l.ourId)).status).toBe("planned");
  });

  it("costs a concurrent double tap no second turn and no second read while the first read runs", async () => {
    const f = await carrier();
    const l = await load(f);
    const judge = await addJudge(admin, f);
    const visit = await visitOf(f, judge, 0);
    const me = { ...judge, demoSessionId: visit };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const reading1 = new Promise<void>((resolve) => {
      started = resolve;
    });
    const answer = reader(reading(l.reference, "pickup", PICKUP_STOP));
    const slow = vi.fn<ReadComplete>(async (t, r, s) => {
      started();
      await gate;
      return answer(t, r, s);
    });
    const first = tap(me, l.reference, "pickup", slow);
    try {
      await reading1;
      const second = reader(reading(l.reference, "pickup", PICKUP_STOP));
      expect(await tap(me, l.reference, "pickup", second, T0 + 5_000)).toEqual({ kind: "refused", category: "not_read" });
      expect(second).not.toHaveBeenCalled();
      expect(await visitTurns(f, visit)).toBe(1);
    } finally {
      release();
    }
    expect(await first).toMatchObject({ kind: "moved", to: "in_transit", board: "moved" });
    expect(slow).toHaveBeenCalledTimes(1);
    expect(await visitTurns(f, visit)).toBe(1);
    expect(await documentsOf(f)).toHaveLength(1);
  });

  it("starts no read, stores nothing and counts no turn when too little of the request is left", async () => {
    const f = await carrier();
    const l = await load(f);
    const judge = await addJudge(admin, f);
    const visit = await visitOf(f, judge, 0);
    const complete = reader(reading(l.reference, "pickup", PICKUP_STOP));
    // The render took 20 of the request's 27 seconds.
    let calls = 0;
    const steady = () => (calls++ === 0 ? 0 : 20_000);
    const out = await sendDriverPaperwork(
      { ...judge, demoSessionId: visit },
      { reference: l.reference, stage: "pickup" },
      { db: app, now: () => new Date(T0), read: { complete }, steady },
    );
    expect(out).toEqual({ kind: "refused", category: "not_read" });
    expect(complete).not.toHaveBeenCalled();
    expect(await documentsOf(f)).toEqual([]);
    expect(await visitTurns(f, visit)).toBe(0);
  });

  it("never reaches another carrier's load", async () => {
    const a = await carrier();
    const b = await carrier();
    const l = await load(a);
    const complete = reader(reading(l.reference, "pickup", PICKUP_STOP));
    expect(await tap(b.session, l.reference, "pickup", complete)).toEqual({ kind: "refused", category: "not_found" });
    expect(complete).not.toHaveBeenCalled();
    expect(await documentsOf(a)).toEqual([]);
    expect(await documentsOf(b)).toEqual([]);
    expect((await ours(a, l.ourId)).status).toBe("planned");
    expect((await boardOf(a, l.reference)).events).toHaveLength(1);
    await expect(tap({ ...b.session, tenantId: a.tenantId }, l.reference, "pickup", complete)).rejects.toThrow();
  });
});
