import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable } from "../db/types";
import { deskHandlers, type Handlers } from "../desk/handlers";
import { DESK_SOURCES, eventKey } from "../desk/keys";
import { wakeDesk } from "../desk/loop";
import { addJudge, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { serviceSession } from "../sweep/service-session";
import { moveFleetIn, moveFromDocument, moveFromMessage, staffMove } from "./movement";

// Load movement against a fresh database, as the app's role, with a fixed clock: every move keeps
// 0004's load CHECKs and 0071's load_events CHECKs, writes exactly one load_events row, and the
// same document read twice (or found by the desk again) is one move. A driver's message moves a
// load only with the whole load number from that load's own driver; anything less is a card with
// no money. A person's press is scoped to their own carrier. The carriers are America/Chicago
// (makeTenant), and only this file's carriers are made; they are removed after.

// Monday Nov 2, 2026, 12:00 in Chicago (CST since Nov 1).
const NOW = new Date("2026-11-02T18:00:00.000Z");
const PICKUP_ON = "2026-11-01";
const savedMove = structuredClone(flags.loadMovement);
const savedDesk = structuredClone(flags.deskLoop);

let admin: Db;
let app: Db;
const made: Fixture[] = [];

async function carrier(slug: string): Promise<Fixture> {
  const f = await makeTenant(admin, `${slug}-${randomUUID().slice(0, 8)}`);
  made.push(f);
  return f;
}

let loadSeq = 0;
async function load(
  f: Fixture,
  over: { status?: string; driverId?: string | null; pickupOn?: string } = {},
): Promise<{ id: string; number: string }> {
  loadSeq += 1;
  const id = randomUUID();
  const number = `MV-L${String(10000 + loadSeq)}`;
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
         dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), $5, 'Joliet', 'IL',
         'Gary', 'IN', CAST($6 AS date), 420, 150000)`,
      [id, number, f.customerId, over.driverId === undefined ? f.driverId : over.driverId, over.status ?? "planned", over.pickupOn ?? PICKUP_ON],
    ),
  );
  return { id, number };
}

type Stop = { role: "pickup" | "delivery"; arrived: string | null; departed: string | null };

function reading(loadNumber: string, date: string, stops: Stop[]) {
  const confidence = Object.fromEntries(
    [
      "document_kind",
      "vendor",
      "date_mmddyyyy",
      "total_cents",
      "load_number",
      "truck_unit",
      "gallons_milli",
      "price_cents",
      "loaded_miles",
      "rate_per_mile_cents",
      "linehaul_cents",
      "fuel_surcharge_cents",
      "customer_name",
      "stops",
    ].map((k) => [k, "high"]),
  );
  return {
    document_kind: "bill_of_lading",
    sample_word: false,
    vendor: null,
    date_mmddyyyy: date,
    total_cents: null,
    load_number: loadNumber,
    truck_unit: null,
    gallons_milli: null,
    price_cents: null,
    loaded_miles: null,
    rate_per_mile_cents: null,
    linehaul_cents: null,
    fuel_surcharge_cents: null,
    customer_name: null,
    stops,
    text_lines: [],
    confidence,
  };
}

// A bill of lading read and matched to the load (whole load number), as the reading code stores it.
async function bol(
  f: Fixture,
  l: { id: string; number: string },
  date: string,
  stops: Stop[],
  at: string,
): Promise<string> {
  const id = randomUUID();
  const match = {
    found: true,
    table: "loads",
    id: l.id,
    humanRef: l.number,
    loadId: l.id,
    driverId: f.driverId,
    fields: [{ name: "load_number", claim: l.number, record: l.number, status: "same" }],
    notes: [],
    supports: null,
  };
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO documents (id, tenant_id, uploaded_by, filename, mime, byte_length, bytes, content_hash, trace_id,
         read_status, document_kind, reading, match, created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'ops', 'bol.pdf', 'application/pdf', 1, decode('00', 'hex'), $2,
         CAST($3 AS uuid), 'read', 'bill_of_lading', CAST($4 AS jsonb), CAST($5 AS jsonb), CAST($6 AS timestamptz),
         CAST($6 AS timestamptz))`,
      [
        id,
        createHash("sha256").update(id).digest("hex"),
        randomUUID(),
        JSON.stringify(reading(l.number, date, stops)),
        JSON.stringify(match),
        at,
      ],
    ),
  );
  return id;
}

// A driver's voice note Muse Spark already sorted, with its English text.
async function voiceNote(f: Fixture, driverId: string | null, text: string, category = "load_update"): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO voice_notes (id, tenant_id, driver_id, trace_id, created_by, status, language, english_text,
         triage_category, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'ops', 'ready', 'en', $4, $5,
         CAST('2026-11-02T17:30:00Z' AS timestamptz))`,
      [id, driverId, randomUUID(), text, category],
    ),
  );
  return id;
}

type LoadState = {
  status: string;
  delivered_on: string | null;
  delivered_at: string | null;
  pickup_arrived_at: string | null;
  pickup_departed_at: string | null;
  delivery_arrived_at: string | null;
  delivery_departed_at: string | null;
};

const iso = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const stateOf = (f: Fixture, loadId: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<LoadState>(
      `SELECT status, to_char(delivered_on, 'YYYY-MM-DD') AS delivered_on, ${iso("delivered_at")} AS delivered_at,
              ${iso("pickup_arrived_at")} AS pickup_arrived_at, ${iso("pickup_departed_at")} AS pickup_departed_at,
              ${iso("delivery_arrived_at")} AS delivery_arrived_at, ${iso("delivery_departed_at")} AS delivery_departed_at
         FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [loadId],
    );
    return row;
  });

const eventsOf = (f: Fixture, loadId: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ from_status: string; to_status: string; source: string; evidence_table: string | null; evidence_id: string | null; at: string }>(
      `SELECT from_status, to_status, source, evidence_table, CAST(evidence_id AS text) AS evidence_id, ${iso("at")} AS at
         FROM load_events WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)
        ORDER BY at, to_status = 'delivered'`,
      [loadId],
    ),
  );

const cardsOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ subject_table: string; subject_id: string; amount_cents: number; args: Record<string, unknown>; status: string }>(
      `SELECT subject_table, CAST(subject_id AS text) AS subject_id, CAST(amount_cents AS integer) AS amount_cents,
              args, status
         FROM proposals WHERE tenant_id = current_tenant_id() AND kind = 'load_move' ORDER BY created_at, id`,
    ),
  );

const fromDocument = (f: Fixture, docId: string, session: Session = f.session) =>
  app.withTenant(f.tenantId, (q) => moveFromDocument(q, session, docId, NOW));

const fromVoice = (f: Fixture, id: string) =>
  app.withTenant(f.tenantId, (q) => moveFromMessage(q, f.session, "voice_notes", id, NOW));

const pickupStop = (arrived: string | null, departed: string | null): Stop => ({ role: "pickup", arrived, departed });
const deliveryStop = (arrived: string | null, departed: string | null): Stop => ({ role: "delivery", arrived, departed });

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
  flags.loadMovement.enabled = true;
  flags.loadMovement.startDate = "2026-10-30";
});

afterEach(() => {
  Object.assign(flags.loadMovement, savedMove);
  flags.deskLoop.enabled = savedDesk.enabled;
  flags.deskLoop.armed = savedDesk.armed;
  flags.deskLoop.startDate = savedDesk.startDate;
});

describe("the paperwork path", () => {
  it("moves a load to in transit on its pickup paper and to delivered on its POD, one event each, CHECKs kept", async () => {
    const f = await carrier("move-paper");
    const l = await load(f);
    // A pickup paper with no stop times read: the stop times stay unknown, never zero dwell.
    const up = await bol(f, l, "11/01/2026", [pickupStop(null, null)], "2026-11-01T20:00:00.000Z");
    const first = await fromDocument(f, up);
    expect(first).toMatchObject({ kind: "moved", loadId: l.id, to: "in_transit" });
    expect(await stateOf(f, l.id)).toMatchObject({
      status: "in_transit",
      pickup_arrived_at: null,
      pickup_departed_at: null,
      delivered_on: null,
      delivered_at: null,
    });

    // The POD with both delivery times printed: delivered at the read departure.
    const pod = await bol(
      f,
      l,
      "11/02/2026",
      [deliveryStop("11/02/2026 8:15 AM CST", "11/02/2026 9:40 AM CST")],
      "2026-11-02T16:00:00.000Z",
    );
    const second = await fromDocument(f, pod);
    expect(second).toMatchObject({ kind: "moved", to: "delivered" });
    expect(await stateOf(f, l.id)).toMatchObject({
      status: "delivered",
      delivered_on: "2026-11-02",
      delivered_at: "2026-11-02T15:40:00.000Z",
      delivery_arrived_at: "2026-11-02T14:15:00.000Z",
      delivery_departed_at: "2026-11-02T15:40:00.000Z",
    });
    const events = await eventsOf(f, l.id);
    expect(events).toEqual([
      { from_status: "planned", to_status: "in_transit", source: "driver_photo", evidence_table: "documents", evidence_id: up, at: "2026-11-01T20:00:00.000Z" },
      { from_status: "in_transit", to_status: "delivered", source: "driver_photo", evidence_table: "documents", evidence_id: pod, at: "2026-11-02T15:40:00.000Z" },
    ]);
    expect(await cardsOf(f)).toEqual([]);
  });

  it("delivers at 17:00 in the carrier's zone when no time was read", async () => {
    const f = await carrier("move-five");
    const l = await load(f, { status: "in_transit" });
    const pod = await bol(f, l, "11/02/2026", [deliveryStop(null, null)], "2026-11-02T16:00:00.000Z");
    expect(await fromDocument(f, pod)).toMatchObject({ kind: "moved", to: "delivered" });
    expect(await stateOf(f, l.id)).toMatchObject({
      status: "delivered",
      delivered_on: "2026-11-02",
      // 17:00 CST is 23:00 UTC.
      delivered_at: "2026-11-02T23:00:00.000Z",
      delivery_arrived_at: null,
      delivery_departed_at: null,
    });
    expect(await eventsOf(f, l.id)).toHaveLength(1);
  });

  it("makes the same document read twice one move", async () => {
    const f = await carrier("move-twice");
    const l = await load(f);
    const up = await bol(f, l, "11/01/2026", [], "2026-11-01T20:00:00.000Z");
    expect(await fromDocument(f, up)).toMatchObject({ kind: "moved" });
    expect(await fromDocument(f, up)).toEqual({ kind: "already", loadId: l.id });
    expect(await eventsOf(f, l.id)).toHaveLength(1);
    // The evidence index holds it even for a write that skipped the status check.
    const dup = admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `INSERT INTO load_events (id, tenant_id, load_id, from_status, to_status, source, evidence_table, evidence_id, at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'planned', 'in_transit', 'driver_photo',
                 'documents', CAST($3 AS uuid), now())`,
        [randomUUID(), l.id, up],
      ),
    );
    expect(await sqlStateOf(dup)).toBe("23505");
  });

  it("makes a card with no money, never a move, for a pickup paper dated outside the window", async () => {
    const f = await carrier("move-card");
    const l = await load(f);
    const late = await bol(f, l, "10/25/2026", [], "2026-11-01T20:00:00.000Z");
    expect(await fromDocument(f, late)).toMatchObject({ kind: "card", reason: "date_out_of_window", loadId: l.id });
    expect((await stateOf(f, l.id)).status).toBe("planned");
    expect(await eventsOf(f, l.id)).toEqual([]);
    const cards = await cardsOf(f);
    expect(cards.map((c) => [c.subject_table, c.subject_id, c.amount_cents, String(c.args.reason)])).toEqual([
      ["loads", l.id, 0, "date_out_of_window"],
    ]);
  });

  it("makes no card that could never be carried out: a POD on a planned load, or one dated after today", async () => {
    const f = await carrier("move-no-card");
    const planned = await load(f);
    const pod = await bol(f, planned, "11/02/2026", [deliveryStop(null, null)], "2026-11-02T16:00:00.000Z");
    expect(await fromDocument(f, pod)).toEqual({ kind: "nothing", category: "no_pickup_paper" });
    const rolling = await load(f, { status: "in_transit" });
    // Dated Nov 5, inside the POD window but after today (Nov 2): a press refuses that date.
    const ahead = await bol(f, rolling, "11/05/2026", [deliveryStop(null, null)], "2026-11-02T16:00:00.000Z");
    expect(await fromDocument(f, ahead)).toEqual({ kind: "nothing", category: "date_out_of_window" });
    expect((await stateOf(f, planned.id)).status).toBe("planned");
    expect((await stateOf(f, rolling.id)).status).toBe("in_transit");
    expect(await cardsOf(f)).toEqual([]);
  });

  it("never takes a paper read in before the start date as the pickup paper", async () => {
    const f = await carrier("move-floor");
    flags.loadMovement.startDate = "2026-11-01";
    const l = await load(f);
    // Read in Oct 31 at 15:00 in Chicago, the day before the start date.
    await bol(f, l, "11/01/2026", [pickupStop(null, null)], "2026-10-31T20:00:00.000Z");
    const pod = await bol(f, l, "11/02/2026", [deliveryStop(null, null)], "2026-11-02T16:00:00.000Z");
    expect(await fromDocument(f, pod)).toEqual({ kind: "nothing", category: "no_pickup_paper" });
    expect((await stateOf(f, l.id)).status).toBe("planned");
    expect(await eventsOf(f, l.id)).toEqual([]);
  });

  it("moves nothing and makes no card for paper on a cancelled load", async () => {
    const f = await carrier("move-cancelled");
    const l = await load(f, { status: "cancelled" });
    const paper = await bol(f, l, "11/01/2026", [pickupStop(null, null)], "2026-11-01T20:00:00.000Z");
    expect(await fromDocument(f, paper)).toEqual({ kind: "nothing", category: "wrong_status" });
    expect((await stateOf(f, l.id)).status).toBe("cancelled");
    expect(await eventsOf(f, l.id)).toEqual([]);
    expect(await cardsOf(f)).toEqual([]);
  });

  it("moves nothing with the switch off or for paper from before the start date", async () => {
    const f = await carrier("move-off");
    const l = await load(f);
    const up = await bol(f, l, "11/01/2026", [], "2026-11-01T20:00:00.000Z");
    flags.loadMovement.enabled = false;
    expect(await fromDocument(f, up)).toEqual({ kind: "nothing", category: "switched_off" });
    flags.loadMovement.enabled = true;
    flags.loadMovement.startDate = "2026-11-02";
    expect(await fromDocument(f, up)).toEqual({ kind: "nothing", category: "switched_off" });
    expect((await stateOf(f, l.id)).status).toBe("planned");
    expect(await cardsOf(f)).toEqual([]);
  });
});

describe("the CHECKs on load_events", () => {
  it("refuses a skipped step, evidence without its source, and any change to a recorded move", async () => {
    const f = await carrier("move-checks");
    const l = await load(f, { status: "in_transit" });
    const insert = (from: string, to: string, source: string, table: string | null, evidence: string | null) =>
      app.withTenant(f.tenantId, (q: Queryable) =>
        q.execute(
          `INSERT INTO load_events (id, tenant_id, load_id, from_status, to_status, source, evidence_table, evidence_id, at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6, CAST($7 AS uuid), now())`,
          [randomUUID(), l.id, from, to, source, table, evidence],
        ),
      );
    expect(await sqlStateOf(insert("planned", "delivered", "staff", null, null))).toBe("23514");
    expect(await sqlStateOf(insert("in_transit", "delivered", "driver_photo", null, null))).toBe("23514");
    expect(await sqlStateOf(insert("in_transit", "delivered", "staff", "documents", randomUUID()))).toBe("23514");
    expect(await sqlStateOf(insert("in_transit", "delivered", "staff", null, null))).toBe("no error");
    const change = app.withTenant(f.tenantId, (q) =>
      q.execute("UPDATE load_events SET source = 'demo_feed' WHERE tenant_id = current_tenant_id()"),
    );
    expect(await sqlStateOf(change)).toBe("42501");
  });
});

describe("the message path", () => {
  it("moves a load on its own driver's note with the whole load number", async () => {
    const f = await carrier("move-note");
    const l = await load(f, { status: "in_transit" });
    const note = await voiceNote(f, f.driverId, `Delivered ${l.number}, all signed`);
    expect(await fromVoice(f, note)).toMatchObject({ kind: "moved", to: "delivered" });
    expect(await stateOf(f, l.id)).toMatchObject({
      status: "delivered",
      delivered_on: "2026-11-02",
      delivered_at: "2026-11-02T17:30:00.000Z",
    });
    expect(await eventsOf(f, l.id)).toEqual([
      { from_status: "in_transit", to_status: "delivered", source: "driver_voice", evidence_table: "voice_notes", evidence_id: note, at: "2026-11-02T17:30:00.000Z" },
    ]);
  });

  it("refuses a note without the whole load number or from another driver as a card, and moves nothing on an unclear one", async () => {
    const f = await carrier("move-refuse");
    const l = await load(f, { status: "in_transit" });
    const digits = l.number.replace(/^MV-L/, "");
    const partial = await voiceNote(f, f.driverId, `Delivered ${digits}`);
    expect(await fromVoice(f, partial)).toMatchObject({ kind: "card", reason: "no_load_number", loadId: null });
    const other = await voiceNote(f, f.otherDriverId, `Delivered ${l.number}`);
    expect(await fromVoice(f, other)).toMatchObject({ kind: "card", reason: "wrong_driver", loadId: l.id });
    const unclear = await voiceNote(f, f.driverId, `${l.number} not delivered yet`);
    expect(await fromVoice(f, unclear)).toEqual({ kind: "nothing", category: "unclear_update" });
    const chat = await voiceNote(f, f.driverId, `Delivered ${l.number}`, "question");
    expect(await fromVoice(f, chat)).toEqual({ kind: "nothing", category: "not_load_update" });

    expect((await stateOf(f, l.id)).status).toBe("in_transit");
    expect(await eventsOf(f, l.id)).toEqual([]);
    const cards = await cardsOf(f);
    expect(cards.every((c) => c.amount_cents === 0)).toBe(true);
    expect(cards.find((c) => c.args.reason === "no_load_number")).toMatchObject({ subject_table: "drivers", subject_id: f.driverId });
    expect(cards.map((c) => c.args.reason).sort()).toEqual(["no_load_number", "wrong_driver"]);
  });

  it("leaves a driver's waiting card alone when a second unclear note comes from the same driver", async () => {
    const f = await carrier("move-driver-card");
    await load(f, { status: "in_transit" });
    const first = await voiceNote(f, f.driverId, "Delivered the load");
    expect(await fromVoice(f, first)).toMatchObject({ kind: "card", reason: "no_load_number", loadId: null });
    const second = await voiceNote(f, f.driverId, "Dropped it off, which load was it");
    expect(await fromVoice(f, second)).toEqual({ kind: "nothing", category: "driver_card_waiting" });
    const cards = await cardsOf(f);
    expect(cards.map((c) => [c.subject_table, c.subject_id, c.status, c.args.evidenceId])).toEqual([
      ["drivers", f.driverId, "proposed", first],
    ]);
  });

  it("never looks for an invoiced load's number", async () => {
    const f = await carrier("move-invoiced");
    const l = await load(f, { status: "in_transit" });
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `UPDATE loads SET status = 'invoiced', delivered_on = CAST('2026-11-01' AS date),
                delivered_at = CAST('2026-11-01T23:00:00Z' AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [l.id],
      ),
    );
    const note = await voiceNote(f, f.driverId, `Delivered ${l.number}`);
    expect(await fromVoice(f, note)).toMatchObject({ kind: "card", reason: "no_load_number", loadId: null });
    expect((await stateOf(f, l.id)).status).toBe("invoiced");
  });

  it("reads a note on a load already delivered as already there, never a card", async () => {
    const f = await carrier("move-already");
    const l = await load(f, { status: "in_transit" });
    const note = await voiceNote(f, f.driverId, `Delivered ${l.number}`);
    expect(await fromVoice(f, note)).toMatchObject({ kind: "moved", to: "delivered" });
    const again = await voiceNote(f, f.driverId, `${l.number} delivered, all signed`);
    expect(await fromVoice(f, again)).toEqual({ kind: "already", loadId: l.id });
    expect(await cardsOf(f)).toEqual([]);
    expect(await eventsOf(f, l.id)).toHaveLength(1);
  });
});

describe("a person's press", () => {
  // A person's press never reads the automatic switch: these run with it off.
  beforeEach(() => {
    flags.loadMovement.enabled = false;
  });

  it("moves one step under the caller's own carrier, refuses another carrier's load and a demo visitor", async () => {
    const a = await carrier("move-staff-a");
    const b = await carrier("move-staff-b");
    const l = await load(a);
    expect(await staffMove(app, b.session, l.id, "in_transit", NOW)).toEqual({ ok: false, category: "not_found" });
    const judge = await addJudge(admin, a);
    const refused = await staffMove(app, judge, l.id, "in_transit", NOW).then(
      () => "no error",
      (e: unknown) => (e as Error).name,
    );
    expect(refused).toBe("ForbiddenError");
    expect((await stateOf(a, l.id)).status).toBe("planned");

    expect(await staffMove(app, a.session, l.id, "delivered", NOW)).toEqual({ ok: false, category: "wrong_status" });
    expect(await staffMove(app, a.session, l.id, "in_transit", NOW)).toEqual({ ok: true, changed: true, to: "in_transit" });
    expect(await staffMove(app, a.session, l.id, "in_transit", NOW)).toEqual({ ok: true, changed: false, to: "in_transit" });
    expect(await staffMove(app, a.session, l.id, "delivered", NOW)).toEqual({ ok: true, changed: true, to: "delivered" });
    expect(await stateOf(a, l.id)).toMatchObject({ status: "delivered", delivered_on: "2026-11-02", delivered_at: NOW.toISOString() });
    const events = await eventsOf(a, l.id);
    expect(events.map((e) => [e.to_status, e.source, e.evidence_table])).toEqual([
      ["in_transit", "staff", null],
      ["delivered", "staff", null],
    ]);
    expect(await staffMove(app, a.session, l.id, "sideways", NOW)).toEqual({ ok: false, category: "validation" });
  });

  it("moves the fleet a few loads a press, leaving the hero driver's loads alone", async () => {
    const f = await carrier("move-fleet");
    const mine = await load(f, { driverId: f.driverId });
    const theirs = await load(f, { driverId: f.otherDriverId });
    const out = await app.withTenant(f.tenantId, (q) => moveFleetIn(q, NOW, f.driverId));
    expect(out).toEqual({ pickedUp: 1, delivered: 0 });
    expect((await stateOf(f, mine.id)).status).toBe("planned");
    expect(await eventsOf(f, theirs.id)).toMatchObject([{ to_status: "in_transit", source: "demo_feed", evidence_table: null }]);
  });
});

describe("the desk's document lane", () => {
  it("finds a read document once and moves its load once, even after the document is read again", async () => {
    const f = await carrier("move-desk");
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@move-test.invalid', 'staff')`,
      ),
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
        source === "document"
          ? {
              ...real.document,
              run: (s, e, ctx) => {
                runs.push(e.eventKey);
                return real.document.run(s, e, ctx);
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

    const l = await load(f);
    const up = await bol(f, l, "11/01/2026", [], "2026-11-01T20:00:00.000Z");
    await wake();
    expect(runs).toEqual([eventKey("document", up)]);
    expect((await stateOf(f, l.id)).status).toBe("in_transit");

    // Read again (the read writes updated_at): the same document is not worked again.
    await admin.withTenant(f.tenantId, (q) =>
      q.execute("UPDATE documents SET updated_at = CAST('2026-11-02T18:10:00Z' AS timestamptz) WHERE id = CAST($1 AS uuid)", [up]),
    );
    now += 20 * 60_000;
    await wake();
    expect(runs).toEqual([eventKey("document", up)]);
    expect(await eventsOf(f, l.id)).toHaveLength(1);
    const done = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ n: number }>(
        `SELECT CAST(count(*) AS integer) AS n FROM desk_log
          WHERE tenant_id = current_tenant_id() AND kind = 'done' AND event_key = $1`,
        [eventKey("document", up)],
      ),
    );
    expect(done[0].n).toBe(1);
  });
});
