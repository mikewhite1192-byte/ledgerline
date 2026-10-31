import type { Queryable } from "../db";
import { parseRead } from "../documents/schema";
import type { ReadStatus } from "../documents/types";
import { paperworkOf, type PaperDocument } from "../loads/paperwork";
import { isUuid } from "../uuid";
import { clockText, isLocalClock, resolve } from "./clocks";

// TMS-MIRROR: the read side of the dispatch mirror, for the agent's read tools and the state
// summary. SELECT only, inside the caller's tenant transaction, every statement naming its tenant
// (`tenant_id = current_tenant_id()`). Nothing here writes, retries or reaches the dispatch system;
// the sync (./sync.ts) is the only writer of mirror rows. The connection's token is never selected.

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const day = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

export const HISTORY_MAX = 20;
export const LINE_ITEMS_MAX = 30;
export const DOCUMENTS_MAX = 20;
export const STOPS_MAX = 12;
export const EVENTS_MAX = 50;
export const EVENTS_DEFAULT = 20;
export const FLEET_MAX = 60;

// The dispatch codes of a load not yet delivered: the fleet board's rows.
export const UNDELIVERED_CODES = ["new", "tendered", "booked", "in_transit", "on_hold", "breakdown"] as const;
const UNDELIVERED_SQL = `(${UNDELIVERED_CODES.map((c) => `'${c}'`).join(", ")})`;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function count(v: unknown): number {
  const n = num(v);
  if (n === null || n < 0) throw new Error("a count could not be read");
  return n;
}

function flagsOf(text: unknown): string[] {
  if (typeof text !== "string") return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---- The connection, for the state summary ----

export type FeedState = {
  system: string;
  lastFullPassAt: string | null;
  eventsToday: number;
  flaggedLoads: number;
};

const FEED_SQL = `SELECT c.system, ${ts("c.last_walk_completed_at")} AS last_walk_completed_at,
       (SELECT count(*) FROM tms_status_events e
         WHERE e.tenant_id = current_tenant_id() AND e.day = CAST($1 AS date)) AS events_today,
       (SELECT count(*) FROM tms_loads l
         WHERE l.tenant_id = current_tenant_id() AND l.gone_at IS NULL AND jsonb_array_length(l.flags) > 0) AS flagged
  FROM tms_connections c
 WHERE c.tenant_id = current_tenant_id()`;

// Null when the carrier has no dispatch connection.
export async function readFeedState(q: Queryable, today: string): Promise<FeedState | null> {
  const rows = await q.query<{ system: string; last_walk_completed_at: string | null; events_today: unknown; flagged: unknown }>(
    FEED_SQL,
    [today],
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("more than one dispatch connection");
  const r = rows[0];
  return {
    system: r.system,
    lastFullPassAt: r.last_walk_completed_at,
    eventsToday: count(r.events_today),
    flaggedLoads: count(r.flagged),
  };
}

const SYSTEM_WORDS: Readonly<Record<string, string>> = { synthetic: "synthetic demo" };

// "Dispatch feed: synthetic demo, last full pass 2:20 PM, 3 events today, 1 flagged", or
// "not connected". Only ids, codes and counts: no dispatch text reaches the summary.
export function feedLine(state: FeedState | null, zone: string): string {
  if (state === null) return "not connected";
  const system = Object.hasOwn(SYSTEM_WORDS, state.system) ? SYSTEM_WORDS[state.system] : "connected";
  const pass = state.lastFullPassAt === null ? "no full pass yet" : `last full pass ${clockText(state.lastFullPassAt, zone)}`;
  const events = `${state.eventsToday} ${state.eventsToday === 1 ? "event" : "events"} today`;
  return `${system}, ${pass}, ${events}, ${state.flaggedLoads} flagged`;
}

export async function hasConnection(q: Queryable): Promise<boolean> {
  const rows = await q.query<{ ok: number }>(
    "SELECT 1 AS ok FROM tms_connections WHERE tenant_id = current_tenant_id()",
  );
  return rows.length > 0;
}

// ---- Times: both clocks and the flag ----

export type TimeView = { utc: string | null; local: string | null; at: string | null; day: string | null; flag: string | null };

// The flag is worked out again from the pair kept on the row (the two-clock rule, ./clocks.ts).
export function timeView(utc: string | null, local: string | null, at: string | null, d: string | null, zone: string): TimeView | null {
  if (at === null && local === null && utc === null) return null;
  let flag: string | null = null;
  if (local !== null && isLocalClock(local)) flag = resolve({ utc, local }, zone).flag;
  return { utc, local, at, day: d, flag };
}

// ---- One load ----

type LoadRow = {
  id: string;
  external_id: string;
  reference: string;
  status_code: string;
  status_label: string;
  customer_external_id: string | null;
  driver_external_id: string | null;
  truck_unit: string | null;
  trailer_unit: string | null;
  vin: string | null;
  stop_count: unknown;
  leg_count: unknown;
  picked_up_utc: string | null;
  picked_up_local: string | null;
  picked_up_at: string | null;
  picked_up_day: string | null;
  delivered_utc: string | null;
  delivered_local: string | null;
  delivered_at: string | null;
  delivered_day: string | null;
  last_completed_utc: string | null;
  last_completed_local: string | null;
  last_completed_at: string | null;
  last_completed_day: string | null;
  revenue_total_cents: unknown;
  driver_pay_total_cents: unknown;
  source_updated_at: string | null;
  finalized_at: string | null;
  gone_at: string | null;
  flags: string | null;
  customer_name: string | null;
  customer_id: string | null;
  driver_name: string | null;
  driver_id: string | null;
};

const LOAD_SQL = `SELECT CAST(l.id AS text) AS id, l.external_id, l.reference, l.status_code, l.status_label,
       l.customer_external_id, l.driver_external_id, l.truck_unit, l.trailer_unit, l.vin, l.stop_count, l.leg_count,
       ${ts("l.picked_up_utc")} AS picked_up_utc, l.picked_up_local, ${ts("l.picked_up_at")} AS picked_up_at,
       ${day("l.picked_up_day")} AS picked_up_day,
       ${ts("l.delivered_utc")} AS delivered_utc, l.delivered_local, ${ts("l.delivered_at")} AS delivered_at,
       ${day("l.delivered_day")} AS delivered_day,
       ${ts("l.last_completed_utc")} AS last_completed_utc, l.last_completed_local,
       ${ts("l.last_completed_at")} AS last_completed_at, ${day("l.last_completed_day")} AS last_completed_day,
       l.revenue_total_cents, l.driver_pay_total_cents, ${ts("l.source_updated_at")} AS source_updated_at,
       ${ts("l.finalized_at")} AS finalized_at, ${ts("l.gone_at")} AS gone_at, CAST(l.flags AS text) AS flags,
       cp.name AS customer_name, CAST(cp.customer_id AS text) AS customer_id,
       dp.name AS driver_name, CAST(dp.driver_id AS text) AS driver_id
  FROM tms_loads l
  LEFT JOIN tms_parties cp ON cp.tenant_id = l.tenant_id AND cp.kind = 'customer' AND cp.external_id = l.customer_external_id
  LEFT JOIN tms_parties dp ON dp.tenant_id = l.tenant_id AND dp.kind = 'driver' AND dp.external_id = l.driver_external_id
 WHERE l.tenant_id = current_tenant_id() AND l.load_id = CAST($1 AS uuid)`;

type OurLoadRow = {
  id: string;
  load_number: string;
  status: string;
  pickup_on: string;
  linehaul_cents: unknown;
  fuel_surcharge_cents: unknown;
  delivered_on: string | null;
  delivered_at: string | null;
  driver_id: string | null;
  customer_id: string | null;
  accessorials_cents: unknown;
  accessorials_count: unknown;
};

const OUR_LOAD_SQL = `SELECT CAST(l.id AS text) AS id, l.load_number, l.status, ${day("l.pickup_on")} AS pickup_on,
       l.linehaul_cents, l.fuel_surcharge_cents, ${day("l.delivered_on")} AS delivered_on,
       ${ts("l.delivered_at")} AS delivered_at, CAST(l.driver_id AS text) AS driver_id,
       CAST(l.customer_id AS text) AS customer_id,
       (SELECT CAST(coalesce(sum(a.amount_cents), 0) AS text) FROM load_accessorials a
         WHERE a.tenant_id = current_tenant_id() AND a.load_id = l.id) AS accessorials_cents,
       (SELECT count(*) FROM load_accessorials a
         WHERE a.tenant_id = current_tenant_id() AND a.load_id = l.id) AS accessorials_count
  FROM loads l
 WHERE l.tenant_id = current_tenant_id() AND l.id = CAST($1 AS uuid)`;

type DocRow = { id: string; read_status: string; document_kind: string | null; reading: string | null; match: string | null; created_at: string };

const OUR_PAPERS_SQL = `SELECT CAST(id AS text) AS id, read_status, document_kind, CAST(reading AS text) AS reading,
       CAST(match AS text) AS match, ${ts("created_at")} AS created_at
  FROM documents
 WHERE tenant_id = current_tenant_id() AND read_status = 'read'
   AND document_kind IN ('bill_of_lading', 'rate_confirmation') AND match->>'loadId' = $1
 ORDER BY created_at, id
 LIMIT 40`;

function jsonOr(text: string | null): unknown {
  if (text === null) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export type OurLoad = {
  id: string;
  loadNumber: string;
  status: string;
  pickupOn: string;
  linehaulCents: number | null;
  fuelSurchargeCents: number | null;
  accessorialsCents: number;
  accessorialsCount: number;
  deliveredOn: string | null;
  deliveredAt: string | null;
  driverId: string | null;
  customerId: string | null;
  // Our own proof of delivery, by the paperwork rules (src/lib/loads/paperwork.ts).
  podDocumentId: string | null;
};

export async function readOurLoad(q: Queryable, loadId: string): Promise<OurLoad | null> {
  if (!isUuid(loadId)) return null;
  const [l] = await q.query<OurLoadRow>(OUR_LOAD_SQL, [loadId]);
  if (!l) return null;
  const docs = await q.query<DocRow>(OUR_PAPERS_SQL, [l.id]);
  const papers: PaperDocument[] = docs.map((d) => ({
    id: d.id,
    readStatus: d.read_status as ReadStatus,
    kind: d.document_kind,
    read: d.reading === null ? null : parseRead(d.reading),
    match: jsonOr(d.match),
    createdAt: d.created_at,
  }));
  const linehaul = num(l.linehaul_cents);
  const paper = paperworkOf({ id: l.id, pickup_on: l.pickup_on, linehaul_cents: linehaul }, papers);
  return {
    id: l.id,
    loadNumber: l.load_number,
    status: l.status,
    pickupOn: l.pickup_on,
    linehaulCents: linehaul,
    fuelSurchargeCents: num(l.fuel_surcharge_cents),
    accessorialsCents: count(l.accessorials_cents),
    accessorialsCount: count(l.accessorials_count),
    deliveredOn: l.delivered_on,
    deliveredAt: l.delivered_at,
    driverId: l.driver_id,
    customerId: l.customer_id,
    podDocumentId: paper.pod,
  };
}

export type TmsLoad = {
  id: string;
  externalId: string;
  reference: string;
  statusCode: string;
  statusLabel: string;
  customer: { externalId: string | null; name: string | null; customerId: string | null };
  driver: { externalId: string | null; name: string | null; driverId: string | null };
  truckUnit: string | null;
  trailerUnit: string | null;
  vin: string | null;
  stopCount: number | null;
  legCount: number | null;
  pickedUp: TimeView | null;
  delivered: TimeView | null;
  lastCompleted: TimeView | null;
  revenueTotalCents: number | null;
  driverPayTotalCents: number | null;
  sourceUpdatedAt: string | null;
  finalizedAt: string | null;
  goneAt: string | null;
  flags: string[];
};

// The mirror row linked to one of our loads, or null when none is.
export async function readTmsLoadFor(q: Queryable, loadId: string, zone: string): Promise<TmsLoad | null> {
  if (!isUuid(loadId)) return null;
  const rows = await q.query<LoadRow>(LOAD_SQL, [loadId]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("more than one dispatch load for a load");
  const r = rows[0];
  return {
    id: r.id,
    externalId: r.external_id,
    reference: r.reference,
    statusCode: r.status_code,
    statusLabel: r.status_label,
    customer: { externalId: r.customer_external_id, name: r.customer_name, customerId: r.customer_id },
    driver: { externalId: r.driver_external_id, name: r.driver_name, driverId: r.driver_id },
    truckUnit: r.truck_unit,
    trailerUnit: r.trailer_unit,
    vin: r.vin,
    stopCount: num(r.stop_count),
    legCount: num(r.leg_count),
    pickedUp: timeView(r.picked_up_utc, r.picked_up_local, r.picked_up_at, r.picked_up_day, zone),
    delivered: timeView(r.delivered_utc, r.delivered_local, r.delivered_at, r.delivered_day, zone),
    lastCompleted: timeView(r.last_completed_utc, r.last_completed_local, r.last_completed_at, r.last_completed_day, zone),
    revenueTotalCents: num(r.revenue_total_cents),
    driverPayTotalCents: num(r.driver_pay_total_cents),
    sourceUpdatedAt: r.source_updated_at,
    finalizedAt: r.finalized_at,
    goneAt: r.gone_at,
    flags: flagsOf(r.flags),
  };
}

// ---- Stops ----

export type TmsStop = {
  id: string;
  ordinal: number;
  kind: string;
  name: string | null;
  city: string | null;
  state: string | null;
  apptFromLocal: string | null;
  apptToLocal: string | null;
  apptFromAt: string | null;
  apptToAt: string | null;
  arrived: TimeView | null;
  completed: TimeView | null;
};

type StopRow = {
  id: string;
  tms_load_id: string;
  ordinal: unknown;
  stop_kind: string;
  name: string | null;
  city: string | null;
  state: string | null;
  appt_from_local: string | null;
  appt_to_local: string | null;
  appt_from_at: string | null;
  appt_to_at: string | null;
  arrived_utc: string | null;
  arrived_local: string | null;
  arrived_at: string | null;
  completed_utc: string | null;
  completed_local: string | null;
  completed_at: string | null;
};

const STOP_COLUMNS = `CAST(s.id AS text) AS id, CAST(s.tms_load_id AS text) AS tms_load_id, s.ordinal, s.stop_kind,
       s.name, s.city, s.state, s.appt_from_local, s.appt_to_local, ${ts("s.appt_from_at")} AS appt_from_at,
       ${ts("s.appt_to_at")} AS appt_to_at, ${ts("s.arrived_utc")} AS arrived_utc, s.arrived_local,
       ${ts("s.arrived_at")} AS arrived_at, ${ts("s.completed_utc")} AS completed_utc, s.completed_local,
       ${ts("s.completed_at")} AS completed_at`;

function stopOf(s: StopRow, zone: string): TmsStop {
  const atDay = (at: string | null, local: string | null) => (local !== null ? local.slice(0, 10) : at === null ? null : at.slice(0, 10));
  return {
    id: s.id,
    ordinal: num(s.ordinal) ?? 0,
    kind: s.stop_kind,
    name: s.name,
    city: s.city,
    state: s.state,
    apptFromLocal: s.appt_from_local,
    apptToLocal: s.appt_to_local,
    apptFromAt: s.appt_from_at,
    apptToAt: s.appt_to_at,
    arrived: timeView(s.arrived_utc, s.arrived_local, s.arrived_at, atDay(s.arrived_at, s.arrived_local), zone),
    completed: timeView(s.completed_utc, s.completed_local, s.completed_at, atDay(s.completed_at, s.completed_local), zone),
  };
}

export async function readStops(q: Queryable, tmsLoadId: string, zone: string): Promise<{ rows: TmsStop[]; total: number }> {
  const rows = await q.query<StopRow>(
    `SELECT ${STOP_COLUMNS} FROM tms_stops s
      WHERE s.tenant_id = current_tenant_id() AND s.tms_load_id = CAST($1 AS uuid)
      ORDER BY s.ordinal, s.id LIMIT ${STOPS_MAX + 1}`,
    [tmsLoadId],
  );
  return { rows: rows.slice(0, STOPS_MAX).map((s) => stopOf(s, zone)), total: rows.length };
}

// ---- History: status events with whether each moved our load ----

export type Moved = "yes" | "card" | "before_start" | "no";

export type TmsEvent = {
  id: string;
  tmsLoadId: string;
  loadId: string | null;
  reference: string;
  loadNumber: string | null;
  field: string;
  newValue: string | null;
  previousValue: string | null;
  changedBy: string | null;
  at: TimeView | null;
  receivedAt: string;
  moved: Moved;
};

type EventRow = {
  id: string;
  tms_load_id: string;
  load_id: string | null;
  reference: string;
  load_number: string | null;
  field: string;
  new_value: string | null;
  previous_value: string | null;
  changed_by: string | null;
  at_utc: string | null;
  at_local: string | null;
  at: string | null;
  day: string | null;
  clock_flag: string | null;
  received_at: string;
  moved_event: boolean;
  moved_card: boolean;
};

// A load_events row naming the event is a move; a load_move card naming it is a card.
const EVENT_COLUMNS = `CAST(e.id AS text) AS id, CAST(e.tms_load_id AS text) AS tms_load_id,
       CAST(l.load_id AS text) AS load_id, l.reference, o.load_number, e.field, e.new_value, e.previous_value,
       e.changed_by, ${ts("e.at_utc")} AS at_utc, e.at_local, ${ts("e.at")} AS at, ${day("e.day")} AS day,
       e.clock_flag, ${ts("e.received_at")} AS received_at,
       EXISTS (SELECT 1 FROM load_events m
                WHERE m.tenant_id = current_tenant_id() AND m.evidence_table = 'tms_status_events'
                  AND m.evidence_id = e.id) AS moved_event,
       EXISTS (SELECT 1 FROM proposals p
                WHERE p.tenant_id = current_tenant_id() AND p.kind = 'load_move'
                  AND p.args->>'evidenceTable' = 'tms_status_events'
                  AND p.args->>'evidenceId' = CAST(e.id AS text)) AS moved_card`;

const EVENT_FROM = `FROM tms_status_events e
  JOIN tms_loads l ON l.tenant_id = e.tenant_id AND l.id = e.tms_load_id
  LEFT JOIN loads o ON o.tenant_id = l.tenant_id AND o.id = l.load_id`;

function movedOf(r: EventRow, startDate: string | null): Moved {
  if (r.moved_event === true) return "yes";
  if (r.moved_card === true) return "card";
  if (r.field === "status" && r.day !== null && (startDate === null || r.day < startDate)) return "before_start";
  return "no";
}

function eventOf(r: EventRow, startDate: string | null): TmsEvent {
  return {
    id: r.id,
    tmsLoadId: r.tms_load_id,
    loadId: r.load_id,
    reference: r.reference,
    loadNumber: r.load_number,
    field: r.field,
    newValue: r.new_value,
    previousValue: r.previous_value,
    changedBy: r.changed_by,
    at: r.at === null ? null : { utc: r.at_utc, local: r.at_local, at: r.at, day: r.day, flag: r.clock_flag },
    receivedAt: r.received_at,
    moved: movedOf(r, startDate),
  };
}

// The load's last status events, newest first, and how many there are in all.
export async function readHistory(
  q: Queryable,
  tmsLoadId: string,
  startDate: string | null,
): Promise<{ rows: TmsEvent[]; total: number }> {
  const rows = await q.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} ${EVENT_FROM}
      WHERE e.tenant_id = current_tenant_id() AND e.tms_load_id = CAST($1 AS uuid)
      ORDER BY e.at DESC, e.received_at DESC, e.id LIMIT ${HISTORY_MAX}`,
    [tmsLoadId],
  );
  const [n] = await q.query<{ n: unknown }>(
    `SELECT count(*) AS n FROM tms_status_events
      WHERE tenant_id = current_tenant_id() AND tms_load_id = CAST($1 AS uuid)`,
    [tmsLoadId],
  );
  return { rows: rows.map((r) => eventOf(r, startDate)), total: count(n?.n) };
}

export type EventFilter = { since: string | null; loadId: string | null; driverId: string | null; limit: number };

// Status events across the carrier, newest first, with the filters given. since is a carrier
// date compared with the event's own resolved day. driverId matches the dispatch driver linked to
// that driver, or our load's own driver.
export async function readEvents(
  q: Queryable,
  filter: EventFilter,
  startDate: string | null,
): Promise<{ rows: TmsEvent[]; total: number }> {
  const where = [
    "e.tenant_id = current_tenant_id()",
    "(CAST($1 AS date) IS NULL OR e.day >= CAST($1 AS date))",
    "(CAST($2 AS uuid) IS NULL OR l.load_id = CAST($2 AS uuid))",
    `(CAST($3 AS uuid) IS NULL OR o.driver_id = CAST($3 AS uuid) OR EXISTS (
        SELECT 1 FROM tms_parties dp
         WHERE dp.tenant_id = current_tenant_id() AND dp.kind = 'driver'
           AND dp.external_id = l.driver_external_id AND dp.driver_id = CAST($3 AS uuid)))`,
  ].join(" AND ");
  const limit = Math.max(1, Math.min(EVENTS_MAX, Math.trunc(filter.limit)));
  const params = [filter.since, filter.loadId, filter.driverId];
  const rows = await q.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE ${where}
      ORDER BY e.at DESC, e.received_at DESC, e.id LIMIT ${limit}`,
    params,
  );
  const [n] = await q.query<{ n: unknown }>(`SELECT count(*) AS n ${EVENT_FROM} WHERE ${where}`, params);
  return { rows: rows.map((r) => eventOf(r, startDate)), total: count(n?.n) };
}

// ---- Line items and documents ----

export type LineItem = { id: string; group: string; typeLabel: string; description: string; amountCents: number };
export type GroupTotal = { group: string; count: number; totalCents: number };

export async function readLineItems(q: Queryable, tmsLoadId: string): Promise<{ rows: LineItem[]; totals: GroupTotal[] }> {
  const rows = await q.query<{ id: string; item_group: string; type_label: string; description: string; amount_cents: unknown }>(
    `SELECT CAST(id AS text) AS id, item_group, type_label, description, amount_cents FROM tms_line_items
      WHERE tenant_id = current_tenant_id() AND tms_load_id = CAST($1 AS uuid)
      ORDER BY item_group, external_id, id LIMIT ${LINE_ITEMS_MAX}`,
    [tmsLoadId],
  );
  const totals = await q.query<{ item_group: string; n: unknown; total: unknown }>(
    `SELECT item_group, count(*) AS n, CAST(sum(amount_cents) AS text) AS total FROM tms_line_items
      WHERE tenant_id = current_tenant_id() AND tms_load_id = CAST($1 AS uuid)
      GROUP BY item_group ORDER BY item_group`,
    [tmsLoadId],
  );
  return {
    rows: rows.map((r) => {
      const cents = num(r.amount_cents);
      if (cents === null) throw new Error("a line item amount could not be read");
      return { id: r.id, group: r.item_group, typeLabel: r.type_label, description: r.description, amountCents: cents };
    }),
    totals: totals.map((t) => {
      const total = num(t.total);
      if (total === null) throw new Error("a line item total could not be read");
      return { group: t.item_group, count: count(t.n), totalCents: total };
    }),
  };
}

export type TmsDocument = {
  id: string;
  fileName: string;
  typeLabel: string | null;
  kind: string;
  uploader: string;
  shared: boolean;
  reviewState: string;
  firstSeenAt: string | null;
};

export async function readDocuments(q: Queryable, tmsLoadId: string): Promise<{ rows: TmsDocument[]; total: number; hasPod: boolean }> {
  const rows = await q.query<{
    id: string;
    file_name: string;
    type_label: string | null;
    doc_kind: string;
    uploader_kind: string;
    shared: boolean;
    review_state: string;
    first_seen_at: string | null;
  }>(
    `SELECT CAST(id AS text) AS id, file_name, type_label, doc_kind, uploader_kind, shared, review_state,
            ${ts("first_seen_at")} AS first_seen_at
       FROM tms_documents
      WHERE tenant_id = current_tenant_id() AND tms_load_id = CAST($1 AS uuid)
      ORDER BY first_seen_at, id LIMIT ${DOCUMENTS_MAX}`,
    [tmsLoadId],
  );
  const [n] = await q.query<{ n: unknown; pods: unknown }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE doc_kind = 'proof_of_delivery') AS pods FROM tms_documents
      WHERE tenant_id = current_tenant_id() AND tms_load_id = CAST($1 AS uuid)`,
    [tmsLoadId],
  );
  return {
    rows: rows.map((d) => ({
      id: d.id,
      fileName: d.file_name,
      typeLabel: d.type_label,
      kind: d.doc_kind,
      uploader: d.uploader_kind,
      shared: d.shared === true,
      reviewState: d.review_state,
      firstSeenAt: d.first_seen_at,
    })),
    total: count(n?.n),
    hasPod: count(n?.pods) > 0,
  };
}

// ---- The fleet board ----

export type FleetRow = {
  tmsLoadId: string;
  loadId: string | null;
  reference: string;
  loadNumber: string | null;
  driver: { externalId: string | null; name: string | null; driverId: string | null };
  statusCode: string;
  statusLabel: string;
  truckUnit: string | null;
  trailerUnit: string | null;
  lastEvent: { id: string; field: string; newValue: string | null; at: string | null } | null;
  nextStop: { kind: string; city: string | null; state: string | null; apptFromLocal: string | null; apptToLocal: string | null } | null;
  flags: string[];
};

export type FleetCounts = { byStatus: Record<string, number>; unlinked: number; gone: number; flagged: number };

type FleetSqlRow = {
  id: string;
  load_id: string | null;
  reference: string;
  load_number: string | null;
  driver_external_id: string | null;
  driver_name: string | null;
  driver_id: string | null;
  status_code: string;
  status_label: string;
  truck_unit: string | null;
  trailer_unit: string | null;
  flags: string | null;
  ev_id: string | null;
  ev_field: string | null;
  ev_new: string | null;
  ev_at: string | null;
  st_kind: string | null;
  st_city: string | null;
  st_state: string | null;
  st_from: string | null;
  st_to: string | null;
  st_from_at: string | null;
  total: unknown;
};

// One row per dispatch driver with an undelivered load: the load on the road first, else the one
// with the earliest next appointment. A load with no driver is its own row. total counts the rows
// before the cap.
const FLEET_KEY = "coalesce(l.driver_external_id, 'load:' || CAST(l.id AS text))";
const FLEET_SQL = `SELECT f.*, count(*) OVER () AS total FROM (
  SELECT DISTINCT ON (${FLEET_KEY})
       CAST(l.id AS text) AS id, CAST(l.load_id AS text) AS load_id, l.reference, o.load_number,
       l.driver_external_id, dp.name AS driver_name, CAST(dp.driver_id AS text) AS driver_id,
       l.status_code, l.status_label, l.truck_unit, l.trailer_unit, CAST(l.flags AS text) AS flags,
       ev.id AS ev_id, ev.field AS ev_field, ev.new_value AS ev_new, ev.at AS ev_at,
       st.stop_kind AS st_kind, st.city AS st_city, st.state AS st_state, st.appt_from_local AS st_from,
       st.appt_to_local AS st_to, st.appt_from_at AS st_from_at, (l.status_code = 'in_transit') AS on_road
    FROM tms_loads l
    LEFT JOIN loads o ON o.tenant_id = l.tenant_id AND o.id = l.load_id
    LEFT JOIN tms_parties dp ON dp.tenant_id = l.tenant_id AND dp.kind = 'driver' AND dp.external_id = l.driver_external_id
    LEFT JOIN LATERAL (
      SELECT CAST(e.id AS text) AS id, e.field, e.new_value, ${ts("e.at")} AS at FROM tms_status_events e
       WHERE e.tenant_id = l.tenant_id AND e.tms_load_id = l.id
       ORDER BY e.at DESC, e.received_at DESC, e.id LIMIT 1) ev ON true
    LEFT JOIN LATERAL (
      SELECT s.stop_kind, s.city, s.state, s.appt_from_local, s.appt_to_local, ${ts("s.appt_from_at")} AS appt_from_at
        FROM tms_stops s
       WHERE s.tenant_id = l.tenant_id AND s.tms_load_id = l.id AND s.completed_at IS NULL
       ORDER BY s.ordinal LIMIT 1) st ON true
   WHERE l.tenant_id = current_tenant_id() AND l.gone_at IS NULL AND l.status_code IN ${UNDELIVERED_SQL}
   ORDER BY ${FLEET_KEY}, (l.status_code = 'in_transit') DESC, st.appt_from_at NULLS LAST, l.reference, l.id
) f
ORDER BY f.on_road DESC, f.st_from_at NULLS LAST, f.reference, f.id
LIMIT ${FLEET_MAX}`;

const FLEET_COUNTS_SQL = `SELECT l.status_code, count(*) FILTER (WHERE l.gone_at IS NULL) AS n,
       count(*) FILTER (WHERE l.gone_at IS NULL AND l.load_id IS NULL) AS unlinked,
       count(*) FILTER (WHERE l.gone_at IS NOT NULL) AS gone,
       count(*) FILTER (WHERE l.gone_at IS NULL AND jsonb_array_length(l.flags) > 0) AS flagged
  FROM tms_loads l WHERE l.tenant_id = current_tenant_id()
 GROUP BY l.status_code ORDER BY l.status_code`;

export async function readFleet(q: Queryable): Promise<{ rows: FleetRow[]; drivers: number; counts: FleetCounts }> {
  const raw = await q.query<FleetSqlRow>(FLEET_SQL);
  const rows: FleetRow[] = raw.map((r) => ({
      tmsLoadId: r.id,
      loadId: r.load_id,
      reference: r.reference,
      loadNumber: r.load_number,
      driver: { externalId: r.driver_external_id, name: r.driver_name, driverId: r.driver_id },
      statusCode: r.status_code,
      statusLabel: r.status_label,
      truckUnit: r.truck_unit,
      trailerUnit: r.trailer_unit,
      lastEvent: r.ev_id === null ? null : { id: r.ev_id, field: r.ev_field ?? "", newValue: r.ev_new, at: r.ev_at },
      nextStop:
        r.st_kind === null
          ? null
          : { kind: r.st_kind, city: r.st_city, state: r.st_state, apptFromLocal: r.st_from, apptToLocal: r.st_to },
      flags: flagsOf(r.flags),
  }));
  const counted = await q.query<{ status_code: string; n: unknown; unlinked: unknown; gone: unknown; flagged: unknown }>(
    FLEET_COUNTS_SQL,
  );
  const counts: FleetCounts = { byStatus: {}, unlinked: 0, gone: 0, flagged: 0 };
  for (const c of counted) {
    const n = count(c.n);
    if (n > 0) counts.byStatus[c.status_code] = n;
    counts.unlinked += count(c.unlinked);
    counts.gone += count(c.gone);
    counts.flagged += count(c.flagged);
  }
  return { rows, drivers: raw.length === 0 ? 0 : count(raw[0].total), counts };
}
