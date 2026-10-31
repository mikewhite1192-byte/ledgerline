import { flags } from "../../../config/flags";
import type { Queryable } from "../../db";
import { instantAt } from "../../seed/calendar";
import { clocksOf, localClockOf } from "../../tms/clocks";
import { SYNTHETIC_LABELS, SYNTHETIC_RENAMED, type TmsStatusCode } from "../../tms/status";
import { addDays, parseInstant, type Instant, type LocalDate } from "../../time/local-date";
import { FAULT_EDIT_CENTS, NO_FAULTS, readDemoFaults, type DemoFaults } from "./faults";
import {
  TmsSourceError,
  type ListBookmark,
  type TwoClocks,
  type Read,
  type TmsContext,
  type TmsDocumentRow,
  type TmsHistoryRow,
  type TmsLineItem,
  type TmsListRow,
  type TmsLoadRecord,
  type TmsPartyKind,
  type TmsPartyRecord,
  type TmsSource,
  type TmsStopRecord,
} from "./types";

// TMS-MIRROR: the synthetic dispatch feed, clean unless a fault switch is on (below). Its
// facts are the tenant's own seeded loads, customers, driver identities and accessorials, read
// through ctx.q (or, at seed time, from the plan), and a clock: from those it serves list rows,
// full records, history, documents, line items and parties, all as of the feed's clock and
// nothing after it. The script per load, in the carrier's named zone: tendered at 16:00 the day
// before pickup, booked at 17:00, in transit at the seeded pickup departure (else 09:20 on the
// pickup day), delivered at the seeded delivered_at (else 14:14 on the pickup day plus one day per
// 450 loaded miles, rounded up), review 49 hours after the delivery window closes, and finalized
// for an invoiced load at its invoice (10:00 on the issue date, never before review). A cancelled
// load is cancelled at 18:00 the day before pickup. Both clocks agree. Windows are 8 hours around
// the scripted times. Ids are `syn:<slug>:<loadNumber>` and suffixes of it. Synthetic only: no
// person, company or file here is real, and nothing is ever sent.
//
// Fault switches (T3, faults.ts): read per call from the tenant's tms_connections.demo_faults, and
// only while flags.tmsSync.demoFaultsEnabled is on; with every switch off the feed is exactly the
// clean one (the seed's snapshot is built from it). Each is applied here and nowhere else:
//   stale_list_rows: a list row shows the status and update time of 30 minutes before the clock.
//   hard_delete: the load in transit on the feed with the lowest load number is not found.
//   clock_skew: every delivery's UTC field is two days before its local field.
//   local_date_shift: ten minutes after a delivery its local date moves back one day (a hand
//     edit; the UTC field stays) and the load's update time moves to the edit.
//   server_errors: every third load read in one source (one sync) throws server_error.
//   history_page_cut: history comes CUT_PAGE rows a page, each later page starting with the last
//     row of the page before.
//   relabeled_status: In Transit is shown as Rolling (SYNTHETIC_RENAMED).
//   custom_status: a Yard check step, the carrier's own status, 30 minutes after pickup.
//   edit_after_finalize: an hour after the latest finalized load was finalized, a rate adjustment
//     line raises its revenue by FAULT_EDIT_CENTS, with a revenue history row.
// While a switch stays on, its one-load picks follow the feed's clock: once the deleted load would
// have delivered, the next load in transit is the deleted one.

const HOUR_MS = 3_600_000;
const MILES_PER_DAY = 450;
const HISTORY_PAGE = 50;

// One load as the feed needs it.
export type SynLoad = {
  loadNumber: string;
  status: "planned" | "in_transit" | "delivered" | "invoiced" | "cancelled";
  pickupOn: LocalDate;
  deliveredAt: Instant | null;
  loadedMiles: number;
  linehaulCents: number | null;
  fuelSurchargeCents: number;
  pickupArrivedAt: Instant | null;
  pickupDepartedAt: Instant | null;
  deliveryArrivedAt: Instant | null;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  customer: { code: string; name: string } | null;
  driverExternalId: string | null;
  truckUnit: string | null;
  accessorials: { kind: string; seq: number; amountCents: number; description: string }[];
  invoiceIssuedOn: LocalDate | null;
};

export type SynWorld = { slug: string; zone: string };

type Step = { code: Exclude<TmsStatusCode, "custom">; at: Instant; by: string };

export type SynScript = {
  externalId: string;
  createdAt: Instant;
  steps: Step[];
  pickupAt: Instant | null;
  deliveredAt: Instant | null;
  finalizedAt: Instant | null;
};

export const loadExternalId = (world: SynWorld, loadNumber: string) => `syn:${world.slug}:${loadNumber}`;

const ms = (i: Instant) => parseInstant(i);
const iso = (n: number) => new Date(n).toISOString();
const passed = (at: Instant | null, nowMs: number): at is Instant => at !== null && ms(at) <= nowMs;

const DESK = "Dispatch desk";
const APP = "Driver app";

const MINUTE_MS = 60_000;
const STALE_MS = 30 * MINUTE_MS;
const SHIFT_AFTER_MS = 10 * MINUTE_MS;
const SKEW_MS = 48 * HOUR_MS;
const YARD_AFTER_MS = 30 * MINUTE_MS;
const EDIT_AFTER_MS = HOUR_MS;
export const CUT_PAGE = 2;
export const YARD_CHECK = "Yard check";

// The whole script of one load, every step, past or not.
export function scriptOf(world: SynWorld, load: SynLoad): SynScript {
  const z = world.zone;
  const dayBefore = addDays(load.pickupOn, -1);
  const createdAt = instantAt(dayBefore, 16, 0, z);
  const steps: Step[] = [
    { code: "tendered", at: createdAt, by: DESK },
    { code: "booked", at: instantAt(dayBefore, 17, 0, z), by: DESK },
  ];
  const base = { externalId: loadExternalId(world, load.loadNumber), createdAt };
  if (load.status === "cancelled") {
    steps.push({ code: "cancelled", at: instantAt(dayBefore, 18, 0, z), by: DESK });
    return { ...base, steps, pickupAt: null, deliveredAt: null, finalizedAt: null };
  }
  const pickupAt = load.pickupDepartedAt ?? instantAt(load.pickupOn, 9, 20, z);
  const days = Math.ceil(load.loadedMiles / MILES_PER_DAY);
  const planned = instantAt(addDays(load.pickupOn, days), 14, 14, z);
  const deliveredAt = load.deliveredAt ?? iso(Math.max(ms(planned), ms(pickupAt) + HOUR_MS));
  const reviewAt = iso(ms(deliveredAt) + 4 * HOUR_MS + 49 * HOUR_MS);
  steps.push({ code: "in_transit", at: pickupAt, by: APP });
  steps.push({ code: "delivered", at: deliveredAt, by: APP });
  steps.push({ code: "review", at: reviewAt, by: DESK });
  let finalizedAt: Instant | null = null;
  if (load.status === "invoiced" && load.invoiceIssuedOn !== null) {
    finalizedAt = iso(Math.max(ms(instantAt(load.invoiceIssuedOn, 10, 0, z)), ms(reviewAt) + HOUR_MS));
    steps.push({ code: "finalized", at: finalizedAt, by: DESK });
  }
  return { ...base, steps, pickupAt, deliveredAt, finalizedAt };
}

// A small stable number from text, for file sizes.
function smallHash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return h;
}

export type SynServed = {
  list: TmsListRow;
  record: TmsLoadRecord;
  history: TmsHistoryRow[];
  documents: TmsDocumentRow[];
  lines: TmsLineItem[];
};

function window(at: Instant, zone: string) {
  return { from: localClockOf(iso(ms(at) - 4 * HOUR_MS), zone), to: localClockOf(iso(ms(at) + 4 * HOUR_MS), zone) };
}

// The loads a one-load fault picks, from the whole feed at its clock (null when its switch is off
// or no load fits): hard_delete's load in transit with the lowest number, and edit_after_finalize's
// load whose edit time (an hour after its finalize) is the latest one passed, ties to the lowest
// number.
export type FaultPicks = { deleted: string | null; edited: string | null };
export const NO_PICKS: FaultPicks = Object.freeze({ deleted: null, edited: null });

const picksNeeded = (f: DemoFaults) => f.hard_delete || f.edit_after_finalize;

export function faultPicks(world: SynWorld, loads: readonly SynLoad[], nowMs: number, faults: DemoFaults): FaultPicks {
  if (!picksNeeded(faults)) return NO_PICKS;
  let deleted: string | null = null;
  let edited: string | null = null;
  let editedAt = Number.NEGATIVE_INFINITY;
  const ordered = [...loads].sort((a, b) => (a.loadNumber < b.loadNumber ? -1 : a.loadNumber > b.loadNumber ? 1 : 0));
  for (const load of ordered) {
    const s = scriptOf(world, load);
    if (faults.hard_delete && deleted === null) {
      const shown = s.steps.filter((x) => ms(x.at) <= nowMs);
      if (shown.length > 0 && shown[shown.length - 1].code === "in_transit") deleted = load.loadNumber;
    }
    if (faults.edit_after_finalize && s.finalizedAt !== null && load.linehaulCents !== null) {
      const at = ms(s.finalizedAt) + EDIT_AFTER_MS;
      if (at <= nowMs && at > editedAt) {
        edited = load.loadNumber;
        editedAt = at;
      }
    }
  }
  return { deleted: faults.hard_delete ? deleted : null, edited: faults.edit_after_finalize ? edited : null };
}

// Whole dollars and cents as text, for a history row's values.
function dollarsOf(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// One status step as the feed shows it: its history key, its label, its time and who made it.
type Shown = { key: string; code: TmsStatusCode; label: string; at: Instant; by: string };

// What the feed shows of one load at its clock, or null before the load exists there (or, with
// hard_delete on, when it is the deleted load). With no faults (the default) it is the clean feed.
export function serveLoad(
  world: SynWorld,
  load: SynLoad,
  nowMs: number,
  faults: DemoFaults = NO_FAULTS,
  picks: FaultPicks = NO_PICKS,
): SynServed | null {
  const s = scriptOf(world, load);
  if (ms(s.createdAt) > nowMs) return null;
  if (faults.hard_delete && picks.deleted === load.loadNumber) return null;
  const z = world.zone;
  const labelOf = (code: Exclude<TmsStatusCode, "custom">) =>
    faults.relabeled_status && code === SYNTHETIC_RENAMED.code ? SYNTHETIC_RENAMED.label : SYNTHETIC_LABELS[code];
  const steps: Shown[] = s.steps.map((x) => ({ key: x.code, code: x.code, label: labelOf(x.code), at: x.at, by: x.by }));
  if (faults.custom_status && s.pickupAt !== null && s.deliveredAt !== null) {
    const yardAt = iso(ms(s.pickupAt) + YARD_AFTER_MS);
    const after = steps.findIndex((x) => x.code === "in_transit");
    if (after >= 0 && ms(yardAt) < ms(s.deliveredAt)) {
      steps.splice(after + 1, 0, { key: "yard_check", code: "custom", label: YARD_CHECK, at: yardAt, by: DESK });
    }
  }
  const shown = steps.filter((x) => ms(x.at) <= nowMs);
  const last = shown[shown.length - 1];
  const label = last.label;
  const picked = passed(s.pickupAt, nowMs) ? s.pickupAt : null;
  const dropped = passed(s.deliveredAt, nowMs) ? s.deliveredAt : null;
  // The delivery's own clocks, as clock_skew and local_date_shift leave them.
  const shifted = faults.local_date_shift && dropped !== null && nowMs >= ms(dropped) + SHIFT_AFTER_MS;
  const dropClocks = (at: Instant): TwoClocks => {
    const c = clocksOf(at, z);
    const utc = faults.clock_skew ? iso(ms(at) - SKEW_MS) : c.utc;
    const local = shifted ? `${addDays(c.local.slice(0, 10), -1)}${c.local.slice(10)}` : c.local;
    return { utc, local };
  };
  const history: TmsHistoryRow[] = shown.map((x, i) => ({
    externalId: `${s.externalId}:${x.key}`,
    field: "status",
    newValue: x.label,
    previousValue: i === 0 ? null : shown[i - 1].label,
    changedBy: x.by,
    at: x.code === "delivered" ? dropClocks(x.at) : clocksOf(x.at, z),
  }));
  const pickupArrived =
    picked === null
      ? null
      : load.pickupArrivedAt !== null && ms(load.pickupArrivedAt) <= ms(picked)
        ? load.pickupArrivedAt
        : iso(ms(picked) - HOUR_MS);
  const deliveryArrived =
    dropped === null
      ? null
      : load.deliveryArrivedAt !== null && ms(load.deliveryArrivedAt) <= ms(dropped)
        ? load.deliveryArrivedAt
        : iso(ms(dropped) - HOUR_MS);
  const pw = s.pickupAt ? window(s.pickupAt, z) : null;
  const dw = s.deliveredAt ? window(s.deliveredAt, z) : null;
  const pickup: TmsStopRecord = {
    name: `${load.originCity} pickup`,
    city: load.originCity,
    state: load.originState,
    apptFromLocal: pw?.from ?? null,
    apptToLocal: pw?.to ?? null,
    arrived: pickupArrived ? clocksOf(pickupArrived, z) : null,
    completed: picked ? clocksOf(picked, z) : null,
  };
  const delivery: TmsStopRecord = {
    name: `${load.destCity} delivery`,
    city: load.destCity,
    state: load.destState,
    apptFromLocal: dw?.from ?? null,
    apptToLocal: dw?.to ?? null,
    arrived: deliveryArrived ? clocksOf(deliveryArrived, z) : null,
    completed: dropped ? dropClocks(dropped) : null,
  };
  const lines: TmsLineItem[] = [];
  if (load.linehaulCents !== null) {
    lines.push({ externalId: `${s.externalId}:line1`, group: "revenue", typeLabel: "Linehaul", description: "Linehaul", amountCents: load.linehaulCents });
  }
  if (load.fuelSurchargeCents > 0) {
    lines.push({
      externalId: `${s.externalId}:line2`,
      group: "revenue",
      typeLabel: "Fuel Surcharge",
      description: "Fuel surcharge",
      amountCents: load.fuelSurchargeCents,
    });
  }
  for (const a of [...load.accessorials].sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.seq - y.seq))) {
    lines.push({
      externalId: `${s.externalId}:acc:${a.kind}:${a.seq}`,
      group: "accessorial",
      typeLabel: a.kind.charAt(0).toUpperCase() + a.kind.slice(1),
      description: a.description.slice(0, 120),
      amountCents: a.amountCents,
    });
  }
  // edit_after_finalize: the picked load's revenue goes up an hour after its finalize.
  const editAt = s.finalizedAt === null ? null : iso(ms(s.finalizedAt) + EDIT_AFTER_MS);
  const edited =
    faults.edit_after_finalize && picks.edited === load.loadNumber && load.linehaulCents !== null && passed(editAt, nowMs);
  const cleanRevenue = load.linehaulCents === null ? null : lines.reduce((n, l) => n + l.amountCents, 0);
  if (edited && cleanRevenue !== null && editAt !== null) {
    lines.push({
      externalId: `${s.externalId}:line3`,
      group: "revenue",
      typeLabel: "Rate Adjustment",
      description: "Rate adjustment after finalize",
      amountCents: FAULT_EDIT_CENTS,
    });
    history.push({
      externalId: `${s.externalId}:revenue`,
      field: "revenue",
      newValue: dollarsOf(cleanRevenue + FAULT_EDIT_CENTS),
      previousValue: dollarsOf(cleanRevenue),
      changedBy: DESK,
      at: clocksOf(editAt, z),
    });
  }
  const size = smallHash(load.loadNumber);
  const documents: TmsDocumentRow[] = [];
  const booked = s.steps[1].at;
  if (ms(booked) <= nowMs) {
    documents.push({
      externalId: `${s.externalId}:doc1`,
      fileName: `ratecon-${load.loadNumber}.pdf`,
      typeLabel: "Rate Confirmation",
      shared: false,
      updatedAt: booked,
      byteLength: 40_000 + size,
      uploaderKind: "office",
    });
  }
  if (picked) {
    documents.push({
      externalId: `${s.externalId}:doc2`,
      fileName: `bol-${load.loadNumber}.jpg`,
      typeLabel: "Bill of Lading",
      shared: true,
      updatedAt: picked,
      byteLength: 180_000 + size,
      uploaderKind: "driver_app",
    });
  }
  if (dropped) {
    documents.push({
      externalId: `${s.externalId}:doc3`,
      fileName: `pod-${load.loadNumber}.jpg`,
      typeLabel: "Proof of Delivery",
      shared: true,
      updatedAt: dropped,
      byteLength: 210_000 + size,
      uploaderKind: "driver_app",
    });
  }
  // The latest change the feed shows: its last step, a later hand edit of the delivery's local
  // date, or a later revenue edit.
  let updatedAt = last.at;
  if (shifted && dropped !== null) updatedAt = iso(Math.max(ms(updatedAt), ms(dropped) + SHIFT_AFTER_MS));
  if (edited && editAt !== null) updatedAt = iso(Math.max(ms(updatedAt), ms(editAt)));
  const revenue = load.linehaulCents === null ? null : lines.reduce((n, l) => n + l.amountCents, 0);
  const record: TmsLoadRecord = {
    externalId: s.externalId,
    reference: load.loadNumber,
    statusLabel: label,
    customer: load.customer ? { externalId: load.customer.code, name: load.customer.name } : null,
    driverExternalId: load.driverExternalId,
    truckUnit: load.truckUnit,
    trailerUnit: null,
    vin: null,
    pickups: [pickup],
    deliveries: [delivery],
    stopCount: 2,
    legCount: 1,
    pickedUp: picked ? clocksOf(picked, z) : null,
    delivered: dropped ? dropClocks(dropped) : null,
    lastDeliveryCompleted: dropped ? dropClocks(dropped) : null,
    revenueTotalCents: revenue,
    driverPayTotalCents: null,
    updatedAt,
    finalizedAt: passed(s.finalizedAt, nowMs) ? s.finalizedAt : null,
  };
  const list: TmsListRow = {
    externalId: s.externalId,
    createdAt: s.createdAt,
    updatedAt,
    statusLabel: label,
    reference: load.loadNumber,
    driverExternalId: load.driverExternalId,
  };
  return { list, record, history, documents, lines };
}

const below = (row: TmsListRow, b: ListBookmark | null) =>
  b === null || row.createdAt < b.createdAt || (row.createdAt === b.createdAt && row.externalId < b.id);

// One load's list row: as of the clock, or with stale_list_rows on, its status and update time as
// of STALE_MS before (the current row when the load did not exist then).
function listRowOf(world: SynWorld, load: SynLoad, nowMs: number, faults: DemoFaults, picks: FaultPicks): TmsListRow | null {
  const now = serveLoad(world, load, nowMs, faults, picks);
  if (now === null || !faults.stale_list_rows) return now?.list ?? null;
  const then = serveLoad(world, load, nowMs - STALE_MS, faults, picks);
  return then === null ? now.list : { ...now.list, statusLabel: then.list.statusLabel, updatedAt: then.list.updatedAt };
}

// One page of the list: newest created first, ties by id, strictly below the bookmark. `next` is
// the last row's bookmark when more rows follow, else null.
export function listPage(
  world: SynWorld,
  loads: readonly SynLoad[],
  nowMs: number,
  from: ListBookmark | null,
  limit: number,
  faults: DemoFaults = NO_FAULTS,
): { rows: TmsListRow[]; next: ListBookmark | null } {
  const picks = faultPicks(world, loads, nowMs, faults);
  const rows = loads
    .map((l) => listRowOf(world, l, nowMs, faults, picks))
    .filter((r): r is TmsListRow => r !== null && below(r, from))
    .sort((a, b) =>
      a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : a.externalId < b.externalId ? 1 : a.externalId > b.externalId ? -1 : 0,
    );
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? { createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].externalId } : null;
  return { rows: page, next };
}

// ---------------------------------------------------------------------------------------------
// The adapter: the same generator over the tenant's own rows, read through ctx.q.

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const LOAD_SQL = `SELECT l.load_number, l.status, to_char(l.pickup_on, 'YYYY-MM-DD') AS pickup_on,
       ${ts("l.delivered_at")} AS delivered_at, CAST(l.loaded_miles AS integer) AS loaded_miles,
       CAST(l.linehaul_cents AS integer) AS linehaul_cents, CAST(l.fuel_surcharge_cents AS integer) AS fuel_surcharge_cents,
       ${ts("l.pickup_arrived_at")} AS pickup_arrived_at, ${ts("l.pickup_departed_at")} AS pickup_departed_at,
       ${ts("l.delivery_arrived_at")} AS delivery_arrived_at,
       l.origin_city, l.origin_state, l.dest_city, l.dest_state, c.code AS customer_code, c.name AS customer_name,
       (SELECT min(i.external_id) FROM driver_identities i
         WHERE i.tenant_id = l.tenant_id AND i.driver_id = l.driver_id AND i.system = 'tms') AS driver_external_id,
       d.truck_unit,
       (SELECT to_char(min(v.issued_on), 'YYYY-MM-DD') FROM invoices v
         WHERE v.tenant_id = l.tenant_id AND v.load_id = l.id AND v.status <> 'void') AS invoice_issued_on,
       CAST(l.id AS text) AS id
  FROM loads l
  LEFT JOIN customers c ON c.tenant_id = l.tenant_id AND c.id = l.customer_id
  LEFT JOIN drivers d ON d.tenant_id = l.tenant_id AND d.id = l.driver_id
 WHERE l.tenant_id = current_tenant_id()`;

type LoadSqlRow = {
  id: string;
  load_number: string;
  status: SynLoad["status"];
  pickup_on: string;
  delivered_at: string | null;
  loaded_miles: number;
  linehaul_cents: number | null;
  fuel_surcharge_cents: number;
  pickup_arrived_at: string | null;
  pickup_departed_at: string | null;
  delivery_arrived_at: string | null;
  origin_city: string;
  origin_state: string;
  dest_city: string;
  dest_state: string;
  customer_code: string | null;
  customer_name: string | null;
  driver_external_id: string | null;
  truck_unit: string | null;
  invoice_issued_on: string | null;
};

function toSynLoad(r: LoadSqlRow, accessorials: SynLoad["accessorials"]): SynLoad {
  return {
    loadNumber: r.load_number,
    status: r.status,
    pickupOn: r.pickup_on,
    deliveredAt: r.delivered_at,
    loadedMiles: Number(r.loaded_miles),
    linehaulCents: r.linehaul_cents === null ? null : Number(r.linehaul_cents),
    fuelSurchargeCents: Number(r.fuel_surcharge_cents),
    pickupArrivedAt: r.pickup_arrived_at,
    pickupDepartedAt: r.pickup_departed_at,
    deliveryArrivedAt: r.delivery_arrived_at,
    originCity: r.origin_city,
    originState: r.origin_state,
    destCity: r.dest_city,
    destState: r.dest_state,
    customer: r.customer_code !== null && r.customer_name !== null ? { code: r.customer_code, name: r.customer_name } : null,
    driverExternalId: r.driver_external_id,
    truckUnit: r.truck_unit,
    accessorials,
    invoiceIssuedOn: r.invoice_issued_on,
  };
}

async function worldOf(ctx: TmsContext): Promise<SynWorld> {
  const rows = await ctx.q.query<{ slug: string }>("SELECT slug FROM tenants WHERE id = current_tenant_id()");
  if (rows.length !== 1 || typeof rows[0].slug !== "string") throw new TmsSourceError("server_error");
  return { slug: rows[0].slug, zone: ctx.zone };
}

// The feed's clock: now, never earlier than the seeded snapshot's instant.
export function feedNowMs(ctx: Pick<TmsContext, "now" | "connection">): number {
  const now = ms(ctx.now);
  return ctx.connection.feedFloorAt ? Math.max(now, ms(ctx.connection.feedFloorAt)) : now;
}

// The load a feed id names, whole, with its accessorials; null when it names none of this tenant's.
async function loadById(ctx: TmsContext, world: SynWorld, externalId: string): Promise<SynLoad | null> {
  const prefix = `syn:${world.slug}:`;
  if (!externalId.startsWith(prefix)) return null;
  const loadNumber = externalId.slice(prefix.length);
  const rows = await ctx.q.query<LoadSqlRow>(`${LOAD_SQL} AND l.load_number = $1`, [loadNumber]);
  if (rows.length !== 1) return null;
  const acc = await ctx.q.query<{ kind: string; seq: number; amount_cents: number; description: string }>(
    `SELECT kind, CAST(seq AS integer) AS seq, CAST(amount_cents AS integer) AS amount_cents, description
       FROM load_accessorials WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)
      ORDER BY kind, seq`,
    [rows[0].id],
  );
  return toSynLoad(
    rows[0],
    acc.map((a) => ({ kind: a.kind, seq: Number(a.seq), amountCents: Number(a.amount_cents), description: a.description })),
  );
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TmsSourceError) throw err;
    console.error(`tms synthetic read failed: ${err instanceof Error ? err.name : "unknown"}`);
    throw new TmsSourceError("server_error");
  }
}

// The tenant's fault switches, read fresh on every call: none while
// flags.tmsSync.demoFaultsEnabled is off, and none unless the tenant's connection is the synthetic
// one. A value that cannot be read is no faults (the clean feed).
async function faultsOf(ctx: TmsContext): Promise<DemoFaults> {
  if (flags.tmsSync.demoFaultsEnabled !== true || ctx.connection.system !== "synthetic") return NO_FAULTS;
  const rows = await ctx.q.query<{ faults: string | null }>(
    `SELECT CAST(demo_faults AS text) AS faults FROM tms_connections
      WHERE tenant_id = current_tenant_id() AND system = 'synthetic'`,
  );
  if (rows.length !== 1 || typeof rows[0].faults !== "string") return NO_FAULTS;
  try {
    return readDemoFaults(JSON.parse(rows[0].faults) as unknown);
  } catch {
    return NO_FAULTS;
  }
}

async function allLoads(ctx: TmsContext): Promise<SynLoad[]> {
  const rows = await ctx.q.query<LoadSqlRow>(`${LOAD_SQL} ORDER BY l.load_number`);
  return rows.map((r) => toSynLoad(r, []));
}

type PicksOf = (ctx: TmsContext, world: SynWorld, faults: DemoFaults) => Promise<FaultPicks>;

// The one-load picks, worked out once per feed clock and set of switches: a source is built per
// pull, so one pull reads the whole feed for its picks once, not once per record read. A read
// that fails is not kept.
function picksCache(): PicksOf {
  let kept: { key: string; picks: Promise<FaultPicks> } | null = null;
  return (ctx, world, faults) => {
    if (!picksNeeded(faults)) return Promise.resolve(NO_PICKS);
    const nowMs = feedNowMs(ctx);
    const key = `${nowMs}|${JSON.stringify(faults)}`;
    if (kept?.key === key) return kept.picks;
    const picks = allLoads(ctx).then((loads) => faultPicks(world, loads, nowMs, faults));
    const entry = { key, picks };
    kept = entry;
    picks.catch(() => {
      if (kept === entry) kept = null;
    });
    return picks;
  };
}

async function served(ctx: TmsContext, externalId: string, faults: DemoFaults, picksOf: PicksOf): Promise<SynServed | null> {
  const world = await worldOf(ctx);
  const load = await loadById(ctx, world, externalId);
  if (!load) return null;
  return serveLoad(world, load, feedNowMs(ctx), faults, await picksOf(ctx, world, faults));
}

// One history page: HISTORY_PAGE rows, or with history_page_cut on, CUT_PAGE new rows a page with
// the page before's last row repeated first (an empty page once the rows run out).
function historyPage(rows: readonly TmsHistoryRow[], page: number, faults: DemoFaults): TmsHistoryRow[] {
  if (!faults.history_page_cut) return rows.slice(page * HISTORY_PAGE, (page + 1) * HISTORY_PAGE);
  const fresh = rows.slice(page * CUT_PAGE, (page + 1) * CUT_PAGE);
  return page === 0 || fresh.length === 0 ? fresh : [rows[page * CUT_PAGE - 1], ...fresh];
}

const GONE = { kind: "gone" } as const;

// One source per sync (tmsSource builds it per pull), so server_errors counts the load reads of
// one sync.
export function createSyntheticSource(): TmsSource {
  const okAt = <T>(ctx: TmsContext, value: T): Read<T> => ({ kind: "ok", value, asOf: iso(feedNowMs(ctx)) });
  let loadReads = 0;
  const picksOf = picksCache();
  return {
    system: "synthetic",
    ready: async () => ({ ok: true }),
    listLoads: (ctx, from, limit) =>
      guarded(async () => {
        const faults = await faultsOf(ctx);
        const world = await worldOf(ctx);
        return listPage(world, await allLoads(ctx), feedNowMs(ctx), from, limit, faults);
      }),
    readLoad: (ctx, externalId) =>
      guarded(async () => {
        const faults = await faultsOf(ctx);
        if (faults.server_errors) {
          loadReads += 1;
          if (loadReads % 3 === 0) throw new TmsSourceError("server_error");
        }
        const s = await served(ctx, externalId, faults, picksOf);
        return s ? okAt(ctx, s.record) : GONE;
      }),
    readHistory: (ctx, externalId, page) =>
      guarded(async () => {
        const faults = await faultsOf(ctx);
        const s = await served(ctx, externalId, faults, picksOf);
        return s ? okAt(ctx, historyPage(s.history, page, faults)) : GONE;
      }),
    readDocuments: (ctx, externalId) =>
      guarded(async () => {
        const s = await served(ctx, externalId, await faultsOf(ctx), picksOf);
        return s ? okAt(ctx, s.documents) : GONE;
      }),
    readLineItems: (ctx, externalId) =>
      guarded(async () => {
        const s = await served(ctx, externalId, await faultsOf(ctx), picksOf);
        return s ? okAt(ctx, s.lines) : GONE;
      }),
    readParty: (ctx, kind, externalId) => guarded(async () => readParty(ctx.q, kind, externalId, (v) => okAt(ctx, v))),
  };
}

async function readParty(
  q: Queryable,
  kind: TmsPartyKind,
  externalId: string,
  ok: (v: TmsPartyRecord) => Read<TmsPartyRecord>,
): Promise<Read<TmsPartyRecord>> {
  if (kind === "customer") {
    const rows = await q.query<{ name: string }>(
      "SELECT name FROM customers WHERE tenant_id = current_tenant_id() AND code = $1",
      [externalId],
    );
    return rows.length === 1 ? ok({ partyKind: kind, externalId, name: rows[0].name, unit: null, vin: null }) : GONE;
  }
  if (kind === "driver") {
    const rows = await q.query<{ name: string; truck_unit: string | null }>(
      `SELECT d.first_name || ' ' || d.last_name AS name, d.truck_unit FROM driver_identities i
         JOIN drivers d ON d.tenant_id = i.tenant_id AND d.id = i.driver_id
        WHERE i.tenant_id = current_tenant_id() AND i.system = 'tms' AND i.external_id = $1`,
      [externalId],
    );
    return rows.length === 1 ? ok({ partyKind: kind, externalId, name: rows[0].name, unit: rows[0].truck_unit, vin: null }) : GONE;
  }
  if (kind === "truck") {
    const rows = await q.query<{ n: number }>(
      "SELECT CAST(count(*) AS integer) AS n FROM drivers WHERE tenant_id = current_tenant_id() AND truck_unit = $1",
      [externalId],
    );
    return rows.length === 1 && Number(rows[0].n) > 0 ? ok({ partyKind: kind, externalId, name: `Truck ${externalId}`, unit: externalId, vin: null }) : GONE;
  }
  return GONE;
}
