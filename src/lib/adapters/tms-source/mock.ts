import { clocksOf } from "../../tms/clocks";
import { SYNTHETIC_LABELS } from "../../tms/status";
import type { DemoFaults } from "./faults";
import { deletedReference, faultedHistory, faultedListRow, faultedRecord } from "./mock-faults";
import { faultsOf, feedNowMs, historyPage, STALE_MS } from "./synthetic";
import {
  TmsSourceError,
  type ListBookmark,
  type Read,
  type TmsContext,
  type TmsDocumentRow,
  type TmsHistoryRow,
  type TmsLineItem,
  type TmsListRow,
  type TmsLoadRecord,
  type TmsSource,
  type TmsStopRecord,
} from "./types";

// MOCK-TMS (0088): the sample dispatch system (/tms-demo) as a dispatch source. It reads the
// tenant's mock_tms_* rows through ctx.q, read only, and answers exactly the contract a vendor
// adapter would: the list walk newest created first below a (createdAt, id) bookmark, never an
// offset; a read by id that finds no row is gone; anything else that fails is a category. Every
// time is one stored instant served as both clocks in the carrier's zone, so a clean read agrees
// with itself, and the record's revenue total is the sum of its revenue and accessorial lines (null
// with no linehaul line, as the synthetic feed serves an unrated load). The demo fault switches it
// acts on (MOCK_FAULTS) are applied by mock-faults.ts over what it read; the store never changes.
// A real vendor adapter differs only in transport.

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const LOAD_COLUMNS = `CAST(id AS text) AS id, external_id, reference, status_label, customer_external_id, customer_name,
       driver_external_id, truck_unit, trailer_unit, vin, ${ts("picked_up_at")} AS picked_up_at,
       ${ts("delivered_at")} AS delivered_at, ${ts("last_completed_at")} AS last_completed_at,
       ${ts("finalized_at")} AS finalized_at, ${ts("created_at")} AS created_at, ${ts("updated_at")} AS updated_at`;

type LoadSqlRow = {
  id: string;
  external_id: string;
  reference: string;
  status_label: string;
  customer_external_id: string | null;
  customer_name: string | null;
  driver_external_id: string | null;
  truck_unit: string | null;
  trailer_unit: string | null;
  vin: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  last_completed_at: string | null;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
};

type StopSqlRow = {
  stop_kind: "pickup" | "delivery";
  name: string;
  city: string;
  state: string;
  appt_from_local: string | null;
  appt_to_local: string | null;
  arrived_at: string | null;
  completed_at: string | null;
};

type EventSqlRow = {
  external_id: string;
  field: string;
  new_value: string | null;
  previous_value: string | null;
  changed_by: string | null;
  at: string;
};

type LineSqlRow = { external_id: string; item_group: TmsLineItem["group"]; type_label: string; description: string; amount_cents: number };

type DocSqlRow = {
  external_id: string;
  file_name: string;
  type_label: string;
  shared: boolean;
  uploader_kind: TmsDocumentRow["uploaderKind"];
  byte_length: number;
  updated_at: string;
};

const GONE = { kind: "gone" } as const;
const iso = (n: number) => new Date(n).toISOString();

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TmsSourceError) throw err;
    console.error(`tms mock read failed: ${err instanceof Error ? err.name : "unknown"}`);
    throw new TmsSourceError("server_error");
  }
}

async function loadRowOf(ctx: TmsContext, externalId: string): Promise<LoadSqlRow | null> {
  const rows = await ctx.q.query<LoadSqlRow>(
    `SELECT ${LOAD_COLUMNS} FROM mock_tms_loads WHERE tenant_id = current_tenant_id() AND external_id = $1`,
    [externalId],
  );
  return rows.length === 1 ? rows[0] : null;
}

// hard_delete's pick, read fresh: the load in transit with the lowest reference.
async function deletedOf(ctx: TmsContext, faults: DemoFaults): Promise<string | null> {
  if (!faults.hard_delete) return null;
  const rows = await ctx.q.query<{ reference: string }>(
    "SELECT reference FROM mock_tms_loads WHERE tenant_id = current_tenant_id() AND status_label = $1",
    [SYNTHETIC_LABELS.in_transit],
  );
  return deletedReference(
    rows.map((r) => r.reference),
    faults,
  );
}

// The load a read by id names, or null when it is not there (or, with hard_delete on, is the
// deleted one).
async function liveLoad(ctx: TmsContext, externalId: string, faults: DemoFaults): Promise<LoadSqlRow | null> {
  const row = await loadRowOf(ctx, externalId);
  if (row === null) return null;
  return row.reference === (await deletedOf(ctx, faults)) ? null : row;
}

async function linesOf(ctx: TmsContext, loadId: string): Promise<TmsLineItem[]> {
  const rows = await ctx.q.query<LineSqlRow>(
    `SELECT external_id, item_group, type_label, description, CAST(amount_cents AS integer) AS amount_cents
       FROM mock_tms_lines WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid)
      ORDER BY external_id`,
    [loadId],
  );
  return rows.map((l) => ({
    externalId: l.external_id,
    group: l.item_group,
    typeLabel: l.type_label,
    description: l.description,
    amountCents: Number(l.amount_cents),
  }));
}

const clocks = (at: string | null, zone: string) => (at === null ? null : clocksOf(at, zone));

async function recordOf(ctx: TmsContext, row: LoadSqlRow): Promise<TmsLoadRecord> {
  const stops = await ctx.q.query<StopSqlRow>(
    `SELECT stop_kind, name, city, state, appt_from_local, appt_to_local, ${ts("arrived_at")} AS arrived_at,
            ${ts("completed_at")} AS completed_at
       FROM mock_tms_stops WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid)
      ORDER BY ordinal`,
    [row.id],
  );
  const lines = await linesOf(ctx, row.id);
  const z = ctx.zone;
  const stopOf = (s: StopSqlRow): TmsStopRecord => ({
    name: s.name,
    city: s.city,
    state: s.state,
    apptFromLocal: s.appt_from_local,
    apptToLocal: s.appt_to_local,
    arrived: clocks(s.arrived_at, z),
    completed: clocks(s.completed_at, z),
  });
  const rated = lines.some((l) => l.group === "revenue" && l.typeLabel === "Linehaul");
  const revenue = rated ? lines.filter((l) => l.group !== "driver_pay").reduce((n, l) => n + l.amountCents, 0) : null;
  const pickups = stops.filter((s) => s.stop_kind === "pickup").map(stopOf);
  const deliveries = stops.filter((s) => s.stop_kind === "delivery").map(stopOf);
  return {
    externalId: row.external_id,
    reference: row.reference,
    statusLabel: row.status_label,
    customer:
      row.customer_external_id !== null && row.customer_name !== null ? { externalId: row.customer_external_id, name: row.customer_name } : null,
    driverExternalId: row.driver_external_id,
    truckUnit: row.truck_unit,
    trailerUnit: row.trailer_unit,
    vin: row.vin,
    pickups,
    deliveries,
    stopCount: stops.length,
    legCount: 1,
    pickedUp: clocks(row.picked_up_at, z),
    delivered: clocks(row.delivered_at, z),
    lastDeliveryCompleted: clocks(row.last_completed_at, z),
    revenueTotalCents: revenue,
    driverPayTotalCents: null,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at,
  };
}

async function historyOf(ctx: TmsContext, loadId: string): Promise<TmsHistoryRow[]> {
  const rows = await ctx.q.query<EventSqlRow>(
    `SELECT external_id, field, new_value, previous_value, changed_by, ${ts("at")} AS at
       FROM mock_tms_events WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid)
      ORDER BY seq`,
    [loadId],
  );
  return rows.map((e) => ({
    externalId: e.external_id,
    field: e.field,
    newValue: e.new_value,
    previousValue: e.previous_value,
    changedBy: e.changed_by,
    at: clocksOf(e.at, ctx.zone),
  }));
}

const LIST_SQL = `SELECT external_id, ${ts("created_at")} AS created_at, ${ts("updated_at")} AS updated_at, status_label,
       reference, driver_external_id
  FROM mock_tms_loads WHERE tenant_id = current_tenant_id()`;

type ListSqlRow = {
  external_id: string;
  created_at: string;
  updated_at: string;
  status_label: string;
  reference: string;
  driver_external_id: string | null;
};

async function listOf(
  ctx: TmsContext,
  from: ListBookmark | null,
  limit: number,
  faults: DemoFaults,
): Promise<{ rows: TmsListRow[]; next: ListBookmark | null }> {
  const order = "ORDER BY created_at DESC, external_id DESC";
  const fetched =
    from === null
      ? await ctx.q.query<ListSqlRow>(`${LIST_SQL} ${order} LIMIT $1`, [limit + 1])
      : await ctx.q.query<ListSqlRow>(
          `${LIST_SQL} AND (created_at, external_id) < (CAST($1 AS timestamptz), $2) ${order} LIMIT $3`,
          [from.createdAt, from.id, limit + 1],
        );
  const page = fetched.slice(0, limit);
  const next = fetched.length > limit ? { createdAt: page[page.length - 1].created_at, id: page[page.length - 1].external_id } : null;
  const deleted = await deletedOf(ctx, faults);
  const stale = new Map<string, { label: string; at: string }>();
  if (faults.stale_list_rows) {
    const rows = await ctx.q.query<{ external_id: string; new_value: string; at: string }>(
      `SELECT DISTINCT ON (e.mock_load_id) l.external_id, e.new_value, ${ts("e.at")} AS at
         FROM mock_tms_events e
         JOIN mock_tms_loads l ON l.tenant_id = e.tenant_id AND l.id = e.mock_load_id
        WHERE e.tenant_id = current_tenant_id() AND e.field = 'status' AND e.new_value IS NOT NULL
          AND e.at <= CAST($1 AS timestamptz)
        ORDER BY e.mock_load_id, e.seq DESC`,
      [iso(feedNowMs(ctx) - STALE_MS)],
    );
    for (const r of rows) stale.set(r.external_id, { label: r.new_value, at: r.at });
  }
  const rows = page
    .filter((r) => r.reference !== deleted)
    .map((r) =>
      faultedListRow(
        {
          externalId: r.external_id,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          statusLabel: r.status_label,
          reference: r.reference,
          driverExternalId: r.driver_external_id,
        },
        stale.get(r.external_id) ?? null,
        faults,
      ),
    );
  return { rows, next };
}

// One source per sync (tmsSource builds it per pull), so server_errors counts the load reads of
// one sync.
export function createMockSource(): TmsSource {
  const okAt = <T>(ctx: TmsContext, value: T): Read<T> => ({ kind: "ok", value, asOf: iso(feedNowMs(ctx)) });
  const faults = (ctx: TmsContext) => faultsOf(ctx, "mock");
  let loadReads = 0;
  return {
    system: "mock",
    ready: async () => ({ ok: true }),
    listLoads: (ctx, from, limit) => guarded(async () => listOf(ctx, from, limit, await faults(ctx))),
    readLoad: (ctx, externalId) =>
      guarded(async () => {
        const f = await faults(ctx);
        if (f.server_errors) {
          loadReads += 1;
          if (loadReads % 3 === 0) throw new TmsSourceError("server_error");
        }
        const row = await liveLoad(ctx, externalId, f);
        return row ? okAt(ctx, faultedRecord(await recordOf(ctx, row), f)) : GONE;
      }),
    readHistory: (ctx, externalId, page) =>
      guarded(async () => {
        const f = await faults(ctx);
        const row = await liveLoad(ctx, externalId, f);
        return row ? okAt(ctx, historyPage(faultedHistory(await historyOf(ctx, row.id), f), page, f)) : GONE;
      }),
    readDocuments: (ctx, externalId) =>
      guarded(async () => {
        const row = await liveLoad(ctx, externalId, await faults(ctx));
        if (!row) return GONE;
        const docs = await ctx.q.query<DocSqlRow>(
          `SELECT external_id, file_name, type_label, shared, uploader_kind, CAST(byte_length AS integer) AS byte_length,
                  ${ts("updated_at")} AS updated_at
             FROM mock_tms_documents WHERE tenant_id = current_tenant_id() AND mock_load_id = CAST($1 AS uuid)
            ORDER BY external_id`,
          [row.id],
        );
        return okAt(
          ctx,
          docs.map((d) => ({
            externalId: d.external_id,
            fileName: d.file_name,
            typeLabel: d.type_label,
            shared: d.shared === true,
            updatedAt: d.updated_at,
            byteLength: Number(d.byte_length),
            uploaderKind: d.uploader_kind,
          })),
        );
      }),
    readLineItems: (ctx, externalId) =>
      guarded(async () => {
        const row = await liveLoad(ctx, externalId, await faults(ctx));
        return row ? okAt(ctx, await linesOf(ctx, row.id)) : GONE;
      }),
    readParty: (ctx, kind, externalId) =>
      guarded(async () => {
        const rows = await ctx.q.query<{ name: string; unit: string | null; vin: string | null }>(
          "SELECT name, unit, vin FROM mock_tms_parties WHERE tenant_id = current_tenant_id() AND kind = $1 AND external_id = $2",
          [kind, externalId],
        );
        return rows.length === 1 ? okAt(ctx, { partyKind: kind, externalId, name: rows[0].name, unit: rows[0].unit, vin: rows[0].vin }) : GONE;
      }),
  };
}
