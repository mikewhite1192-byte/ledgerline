import { SYNTHETIC_LABELS, type TmsStatusCode } from "../tms/status";
import { instantOfLocal, isLocalClock, localClockOf } from "../tms/clocks";
import { DbError, type Param, type Queryable } from "../db";
import { parseInstant, type Instant } from "../time/local-date";
import { changeAt } from "./clock";

// MOCK-TMS (0088): the sample dispatch system's own writes, a person's changes on /tms-demo, and
// its reads for those pages. This is the stand-in for the carrier's TMS, not LedgerLine: nothing
// here touches our loads, cards or money; the desk learns of a change only by reading the store
// through the read-only `mock` dispatch source. Every change runs inside the caller's tenant
// transaction (RLS keeps it to that carrier): it locks the load, refuses past the history cap,
// writes one history row per change (from, to, who, when) and stamps the load's update time, all
// or nothing. Status is one field, set from the list or moved by an action, backward too, as a
// real system lets a dispatcher do; only these needs are checked, as that system checks them:
// Booked needs a driver on the load, Delivered needs a proof of delivery on file.
//   assign driver: the driver (one history row); a New or Tendered load also moves to Booked.
//   complete pickup: the first open pickup's arrival and departure; the load moves to In Transit.
//   complete delivery: the last delivery's arrival and departure, after the pickup, and a proof of
//     delivery document row (metadata only, as the driver app would upload it); the load moves to
//     Delivered.
//   set status: any status in STATUS_CHOICES; Archived is how a load is cancelled here. A load is
//     never deleted from these pages.
// Times a person types are the carrier's local wall time (`YYYY-MM-DDTHH:mm`, the carrier's zone).

// The statuses a person may set, in the order the list shows them.
export const STATUS_CHOICES: readonly Exclude<TmsStatusCode, "custom">[] = [
  "new",
  "tendered",
  "booked",
  "in_transit",
  "delivered",
  "review",
  "pay_ready",
  "finalized",
  "invoice_hold",
  "invoiced",
  "paid",
  "on_hold",
  "breakdown",
  "archived",
  "cancelled",
];

const L = SYNTHETIC_LABELS;
const POD_TYPE = "Proof of Delivery";
// The size the store gives a proof of delivery a stop completion records (never zero: the mirror
// skips a zero-byte placeholder).
const POD_BYTES = 210_000;
// How far back a typed stop time may be.
const MAX_BACKDATE_MS = 7 * 24 * 3_600_000;

export type MockAction =
  | { kind: "assign_driver"; driverExternalId: string }
  | { kind: "complete_pickup"; arrivedLocal: string | null; departedLocal: string | null }
  | { kind: "complete_delivery"; arrivedLocal: string | null; departedLocal: string | null }
  | { kind: "set_status"; code: string };

export type MockRefusal =
  | "not_found"
  | "cap"
  | "unknown_driver"
  | "same_driver"
  | "no_driver"
  | "no_pod"
  | "no_open_stop"
  | "pickup_first"
  | "before_pickup"
  | "bad_time"
  | "bad_status"
  | "same_status";

export type MockResult = { ok: true; externalId: string; at: Instant } | { ok: false; category: MockRefusal };

export type MockWho = "admin" | "staff" | "judge";
export const WHO_WORDS: Record<MockWho, string> = { admin: "Dispatch desk (admin)", staff: "Dispatch desk", judge: "Demo visitor" };

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

type Locked = {
  id: string;
  external_id: string;
  reference: string;
  status_label: string;
  driver_external_id: string | null;
  updated_at: string;
  feed_floor_at: string | null;
  zone: string;
  events: number;
  latest_at: string | null;
};

// The tenant's sample-system load by its reference, locked, with what a change needs; null when the
// tenant is not on the sample system or has no such load.
async function lockLoad(q: Queryable, reference: string): Promise<Locked | null> {
  const conn = await q.query<{ system: string; feed_floor_at: string | null; zone: string }>(
    `SELECT c.system, ${ts("c.feed_floor_at")} AS feed_floor_at, t.timezone AS zone
       FROM tms_connections c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.tenant_id = current_tenant_id()`,
  );
  if (conn.length !== 1 || conn[0].system !== "mock") return null;
  const rows = await q.query<Omit<Locked, "feed_floor_at" | "zone" | "events" | "latest_at">>(
    `SELECT CAST(id AS text) AS id, external_id, reference, status_label, driver_external_id, ${ts("updated_at")} AS updated_at
       FROM mock_tms_loads WHERE tenant_id = current_tenant_id() AND reference = $1 FOR UPDATE`,
    [reference],
  );
  if (rows.length !== 1) return null;
  const ev = await q.query<{ n: number; latest_at: string | null }>(
    `SELECT CAST(count(*) AS integer) AS n, ${ts("max(at)")} AS latest_at
       FROM mock_tms_events WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid)`,
    [rows[0].id],
  );
  return { ...rows[0], feed_floor_at: conn[0].feed_floor_at, zone: conn[0].zone, events: Number(ev[0]?.n ?? 0), latest_at: ev[0]?.latest_at ?? null };
}

type Row = { field: string; from: string | null; to: string | null };

async function writeRows(q: Queryable, load: Locked, rows: readonly Row[], who: MockWho, at: Instant): Promise<void> {
  let seq = load.events;
  for (const r of rows) {
    seq += 1;
    const n = await q.execute(
      `INSERT INTO mock_tms_events (id, tenant_id, mock_load_id, seq, external_id, field, new_value, previous_value, changed_by, at)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), $2, $3, $4, $5, $6, $7, CAST($8 AS timestamptz))`,
      [load.id, seq, `${load.external_id}:e${seq}`, r.field, r.to, r.from, WHO_WORDS[who], at],
    );
    if (n !== 1) throw new DbError("unknown");
  }
}

async function touch(q: Queryable, load: Locked, sets: string, params: Param[], at: Instant): Promise<void> {
  const n = await q.execute(
    `UPDATE mock_tms_loads SET ${sets}${sets ? ", " : ""}updated_at = CAST($1 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($2 AS uuid)`,
    [at, load.id, ...params],
  );
  if (n !== 1) throw new DbError("unknown");
}

async function hasPod(q: Queryable, loadId: string): Promise<boolean> {
  const rows = await q.query<{ n: number }>(
    `SELECT CAST(count(*) AS integer) AS n FROM mock_tms_documents
      WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid) AND type_label = $2 AND byte_length > 0`,
    [loadId, POD_TYPE],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

// A stop's typed times, or the change time for a time left blank: arrival at or before departure,
// departure at or before the change, neither more than seven days back.
function stopTimes(load: Locked, at: Instant, arrivedLocal: string | null, departedLocal: string | null) {
  const read = (v: string | null) => (v === null ? at : isLocalClock(v) ? instantOfLocal(v, load.zone) : null);
  const departed = read(departedLocal);
  const arrived = arrivedLocal === null && departed !== null ? departed : read(arrivedLocal);
  if (arrived === null || departed === null) return null;
  const atMs = parseInstant(at);
  const a = parseInstant(arrived);
  const d = parseInstant(departed);
  if (a > d || d > atMs || a < atMs - MAX_BACKDATE_MS) return null;
  return { arrived, departed };
}

function statusRows(load: Locked, to: string): Row[] {
  return load.status_label === to ? [] : [{ field: "status", from: load.status_label, to }];
}

export async function applyMockAction(
  q: Queryable,
  reference: string,
  action: MockAction,
  who: MockWho,
  opts: { nowMs: number; maxEventsPerLoad: number },
): Promise<MockResult> {
  const load = await lockLoad(q, reference);
  if (load === null) return { ok: false, category: "not_found" };
  const at = changeAt(opts.nowMs, load.feed_floor_at, [load.latest_at, load.updated_at]);
  const fail = (category: MockRefusal): MockResult => ({ ok: false, category });
  const capped = (rows: number) => load.events + rows > opts.maxEventsPerLoad;
  const done = (): MockResult => ({ ok: true, externalId: load.external_id, at });

  if (action.kind === "assign_driver") {
    const party = await q.query<{ n: number }>(
      `SELECT CAST(count(*) AS integer) AS n FROM mock_tms_parties
        WHERE tenant_id = current_tenant_id() AND kind = 'driver' AND external_id = $1`,
      [action.driverExternalId],
    );
    if (Number(party[0]?.n ?? 0) !== 1) return fail("unknown_driver");
    if (load.driver_external_id === action.driverExternalId) return fail("same_driver");
    const books = load.status_label === L.new || load.status_label === L.tendered;
    const rows: Row[] = [
      { field: "driver", from: load.driver_external_id, to: action.driverExternalId },
      ...(books ? statusRows(load, L.booked) : []),
    ];
    if (capped(rows.length)) return fail("cap");
    await writeRows(q, load, rows, who, at);
    await touch(q, load, books ? "driver_external_id = $3, status_label = $4" : "driver_external_id = $3", books ? [action.driverExternalId, L.booked] : [action.driverExternalId], at);
    return done();
  }

  if (action.kind === "complete_pickup" || action.kind === "complete_delivery") {
    const pickup = action.kind === "complete_pickup";
    const times = stopTimes(load, at, action.arrivedLocal, action.departedLocal);
    if (times === null) return fail("bad_time");
    const stops = await q.query<{ id: string; stop_kind: string; completed: boolean; completed_at: string | null }>(
      `SELECT CAST(id AS text) AS id, stop_kind, completed_at IS NOT NULL AS completed,
              to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at FROM mock_tms_stops
        WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid) ORDER BY ordinal`,
      [load.id],
    );
    const pickups = stops.filter((s) => s.stop_kind === "pickup");
    const deliveries = stops.filter((s) => s.stop_kind === "delivery");
    const stop = pickup ? pickups.find((s) => !s.completed) : deliveries[deliveries.length - 1];
    if (!stop || stop.completed) return fail("no_open_stop");
    if (!pickup && pickups.some((s) => !s.completed)) return fail("pickup_first");
    // A delivery starts no earlier than the last pickup left and ends after it, so the two stop
    // rows never share a time and Delivered is never dated before In Transit.
    if (!pickup) {
      const left = Math.max(...pickups.map((s) => Date.parse(s.completed_at as string)));
      if (Date.parse(times.arrived) < left || Date.parse(times.departed) <= left) return fail("before_pickup");
    }
    const to = pickup ? L.in_transit : L.delivered;
    const local = localClockOf(times.departed, load.zone);
    const moves = statusRows(load, to);
    // One row per change: the status move, or, when the load already shows that status, the stop.
    const rows: Row[] = moves.length > 0 ? moves : [{ field: pickup ? "pickup_completed" : "delivery_completed", from: null, to: local }];
    if (capped(rows.length)) return fail("cap");
    const n = await q.execute(
      `UPDATE mock_tms_stops SET arrived_at = CAST($1 AS timestamptz), completed_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($3 AS uuid) AND completed_at IS NULL`,
      [times.arrived, times.departed, stop.id],
    );
    if (n !== 1) throw new DbError("unknown");
    if (!pickup) {
      await q.execute(
        `INSERT INTO mock_tms_documents (id, tenant_id, mock_load_id, external_id, file_name, type_label, shared, uploader_kind, byte_length, updated_at)
         VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), $2, $3, $4, true, 'driver_app', $5, CAST($6 AS timestamptz))
         ON CONFLICT (tenant_id, external_id) DO NOTHING`,
        [load.id, `${load.external_id}:doc3`, `pod-${load.reference}.jpg`, POD_TYPE, POD_BYTES, times.departed],
      );
    }
    // The stop's row is dated at its departure, as a dispatch system dates a completed stop, so a
    // back-dated delivery keeps its own day when LedgerLine moves the load.
    await writeRows(q, load, rows, who, times.departed);
    await touch(
      q,
      load,
      pickup
        ? "status_label = $3, picked_up_at = COALESCE(picked_up_at, CAST($4 AS timestamptz))"
        : "status_label = $3, delivered_at = CAST($4 AS timestamptz), last_completed_at = CAST($4 AS timestamptz)",
      [to, times.departed],
      at,
    );
    return done();
  }

  const code = action.code;
  if (!(STATUS_CHOICES as readonly string[]).includes(code)) return fail("bad_status");
  const to = L[code as Exclude<TmsStatusCode, "custom">];
  if (to === load.status_label) return fail("same_status");
  if (code === "booked" && load.driver_external_id === null) return fail("no_driver");
  if (code === "delivered" && !(await hasPod(q, load.id))) return fail("no_pod");
  if (capped(1)) return fail("cap");
  await writeRows(q, load, statusRows(load, to), who, at);
  await touch(
    q,
    load,
    code === "finalized" ? "status_label = $3, finalized_at = COALESCE(finalized_at, CAST($1 AS timestamptz))" : "status_label = $3",
    [to],
    at,
  );
  return done();
}

// The last webhook send's category, after the change committed (never the key, the address or a body).
export async function recordHookResult(q: Queryable, externalId: string, result: string, at: Instant): Promise<void> {
  await q.execute(
    `UPDATE mock_tms_loads SET last_hook_at = CAST($1 AS timestamptz), last_hook_result = $2
      WHERE tenant_id = current_tenant_id() AND external_id = $3`,
    [at, result, externalId],
  );
}

// ---------------------------------------------------------------------------------------------
// Reads for the pages.

export type BoardRow = {
  reference: string;
  statusLabel: string;
  customerName: string | null;
  driverExternalId: string | null;
  truckUnit: string | null;
  lane: string;
  updatedAt: Instant;
};

// The tenant's board, newest created first; null when the tenant is not on the sample system.
export async function readBoard(q: Queryable): Promise<{ zone: string; rows: BoardRow[] } | null> {
  const conn = await q.query<{ system: string; zone: string }>(
    `SELECT c.system, t.timezone AS zone FROM tms_connections c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.tenant_id = current_tenant_id()`,
  );
  if (conn.length !== 1 || conn[0].system !== "mock") return null;
  const rows = await q.query<{
    reference: string;
    status_label: string;
    customer_name: string | null;
    driver_external_id: string | null;
    truck_unit: string | null;
    lane: string | null;
    updated_at: string;
  }>(
    `SELECT l.reference, l.status_label, l.customer_name, l.driver_external_id, l.truck_unit, ${ts("l.updated_at")} AS updated_at,
            (SELECT string_agg(s.city || ', ' || s.state, ' to ' ORDER BY s.ordinal) FROM mock_tms_stops s
              WHERE s.tenant_id = l.tenant_id AND s.mock_load_id = l.id) AS lane
       FROM mock_tms_loads l WHERE l.tenant_id = current_tenant_id()
      ORDER BY l.created_at DESC, l.external_id DESC`,
  );
  return {
    zone: conn[0].zone,
    rows: rows.map((r) => ({
      reference: r.reference,
      statusLabel: r.status_label,
      customerName: r.customer_name,
      driverExternalId: r.driver_external_id,
      truckUnit: r.truck_unit,
      lane: r.lane ?? "",
      updatedAt: r.updated_at,
    })),
  };
}

export type MockLoadView = {
  zone: string;
  load: {
    reference: string;
    externalId: string;
    statusLabel: string;
    customerName: string | null;
    driverExternalId: string | null;
    truckUnit: string | null;
    pickedUpAt: Instant | null;
    deliveredAt: Instant | null;
    finalizedAt: Instant | null;
    updatedAt: Instant;
    lastHookAt: Instant | null;
    lastHookResult: string | null;
  };
  stops: {
    kind: "pickup" | "delivery";
    name: string;
    city: string;
    state: string;
    apptFromLocal: string | null;
    apptToLocal: string | null;
    arrivedAt: Instant | null;
    completedAt: Instant | null;
  }[];
  lines: { typeLabel: string; description: string; amountCents: number }[];
  documents: { fileName: string; typeLabel: string; uploaderKind: string; updatedAt: Instant }[];
  history: { seq: number; field: string; from: string | null; to: string | null; by: string | null; at: Instant }[];
  drivers: { externalId: string; name: string }[];
};

export async function readMockLoad(q: Queryable, reference: string): Promise<MockLoadView | null> {
  const board = await q.query<{ system: string; zone: string }>(
    `SELECT c.system, t.timezone AS zone FROM tms_connections c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.tenant_id = current_tenant_id()`,
  );
  if (board.length !== 1 || board[0].system !== "mock") return null;
  const loads = await q.query<{
    id: string;
    external_id: string;
    reference: string;
    status_label: string;
    customer_name: string | null;
    driver_external_id: string | null;
    truck_unit: string | null;
    picked_up_at: string | null;
    delivered_at: string | null;
    finalized_at: string | null;
    updated_at: string;
    last_hook_at: string | null;
    last_hook_result: string | null;
  }>(
    `SELECT CAST(id AS text) AS id, external_id, reference, status_label, customer_name, driver_external_id, truck_unit,
            ${ts("picked_up_at")} AS picked_up_at, ${ts("delivered_at")} AS delivered_at, ${ts("finalized_at")} AS finalized_at,
            ${ts("updated_at")} AS updated_at, ${ts("last_hook_at")} AS last_hook_at, last_hook_result
       FROM mock_tms_loads WHERE tenant_id = current_tenant_id() AND reference = $1`,
    [reference],
  );
  if (loads.length !== 1) return null;
  const l = loads[0];
  const stops = await q.query<{
    stop_kind: "pickup" | "delivery";
    name: string;
    city: string;
    state: string;
    appt_from_local: string | null;
    appt_to_local: string | null;
    arrived_at: string | null;
    completed_at: string | null;
  }>(
    `SELECT stop_kind, name, city, state, appt_from_local, appt_to_local, ${ts("arrived_at")} AS arrived_at,
            ${ts("completed_at")} AS completed_at
       FROM mock_tms_stops WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid) ORDER BY ordinal`,
    [l.id],
  );
  const lines = await q.query<{ type_label: string; description: string; amount_cents: number }>(
    `SELECT type_label, description, CAST(amount_cents AS integer) AS amount_cents
       FROM mock_tms_lines WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid) ORDER BY external_id`,
    [l.id],
  );
  const documents = await q.query<{ file_name: string; type_label: string; uploader_kind: string; updated_at: string }>(
    `SELECT file_name, type_label, uploader_kind, ${ts("updated_at")} AS updated_at
       FROM mock_tms_documents WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid) ORDER BY external_id`,
    [l.id],
  );
  const history = await q.query<{
    seq: number;
    field: string;
    new_value: string | null;
    previous_value: string | null;
    changed_by: string | null;
    at: string;
  }>(
    `SELECT CAST(seq AS integer) AS seq, field, new_value, previous_value, changed_by, ${ts("at")} AS at
       FROM mock_tms_events WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid) ORDER BY seq DESC`,
    [l.id],
  );
  const drivers = await q.query<{ external_id: string; name: string }>(
    `SELECT external_id, name FROM mock_tms_parties WHERE tenant_id = current_tenant_id() AND kind = 'driver'
      ORDER BY name, external_id`,
  );
  return {
    zone: board[0].zone,
    load: {
      reference: l.reference,
      externalId: l.external_id,
      statusLabel: l.status_label,
      customerName: l.customer_name,
      driverExternalId: l.driver_external_id,
      truckUnit: l.truck_unit,
      pickedUpAt: l.picked_up_at,
      deliveredAt: l.delivered_at,
      finalizedAt: l.finalized_at,
      updatedAt: l.updated_at,
      lastHookAt: l.last_hook_at,
      lastHookResult: l.last_hook_result,
    },
    stops: stops.map((s) => ({
      kind: s.stop_kind,
      name: s.name,
      city: s.city,
      state: s.state,
      apptFromLocal: s.appt_from_local,
      apptToLocal: s.appt_to_local,
      arrivedAt: s.arrived_at,
      completedAt: s.completed_at,
    })),
    lines: lines.map((x) => ({ typeLabel: x.type_label, description: x.description, amountCents: Number(x.amount_cents) })),
    documents: documents.map((d) => ({ fileName: d.file_name, typeLabel: d.type_label, uploaderKind: d.uploader_kind, updatedAt: d.updated_at })),
    history: history.map((h) => ({ seq: Number(h.seq), field: h.field, from: h.previous_value, to: h.new_value, by: h.changed_by, at: h.at })),
    drivers: drivers.map((d) => ({ externalId: d.external_id, name: d.name })),
  };
}
