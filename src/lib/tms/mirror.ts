import type {
  TmsDocumentRow as TmsDocumentRead,
  TmsHistoryRow,
  TmsLineItem,
  TmsLoadRecord,
  TmsStopRecord,
  TwoClocks,
} from "../adapters/tms-source/types";
import { instantOfLocal, resolve, type ClockFlag } from "./clocks";
import { codeOf, docKindOf, type TmsStatusCode } from "./status";

// TMS-MIRROR: what a full read becomes in the mirror's columns (0075). Pure, shared by the sync
// (src/lib/tms/sync.ts) and the seed's snapshot (src/lib/seed/tms.ts), so a seeded mirror is
// exactly what the sync would have written from the same read. Every time is kept three ways:
// both clocks as given, then the moment and the day the two-clock rule resolved (clocks.ts).

export type MirrorFlag = "clocks_disagree" | "stale_list_row" | "multi_leg" | "read_failed" | "unlinked" | "edited_after_finalize";
export const MIRROR_FLAGS: readonly MirrorFlag[] = [
  "clocks_disagree",
  "stale_list_row",
  "multi_leg",
  "read_failed",
  "unlinked",
  "edited_after_finalize",
];

type Kept = { utc: string | null; local: string | null; at: string | null; day: string | null; flag: ClockFlag | null };

function kept(pair: TwoClocks | null, zone: string): Kept {
  if (pair === null) return { utc: null, local: null, at: null, day: null, flag: null };
  const r = resolve(pair, zone);
  return { utc: pair.utc, local: pair.local, at: r.at, day: r.day, flag: r.flag };
}

export type MirrorLoadColumns = {
  external_id: string;
  reference: string;
  status_code: TmsStatusCode;
  status_label: string;
  customer_external_id: string | null;
  driver_external_id: string | null;
  truck_unit: string | null;
  trailer_unit: string | null;
  vin: string | null;
  stop_count: number;
  leg_count: number;
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
  revenue_total_cents: number | null;
  driver_pay_total_cents: number | null;
  source_updated_at: string;
  finalized_at: string | null;
};

export type MirrorStopColumns = {
  ordinal: number;
  stop_kind: "pickup" | "delivery";
  name: string;
  city: string;
  state: string;
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

export type MirrorEventColumns = {
  external_event_id: string;
  field: string;
  new_value: string | null;
  previous_value: string | null;
  changed_by: string | null;
  at_utc: string | null;
  at_local: string;
  at: string;
  day: string;
  clock_flag: ClockFlag | null;
};

export type MirrorLineColumns = {
  external_id: string;
  item_group: TmsLineItem["group"];
  type_label: string;
  description: string;
  amount_cents: number;
};

export type MirrorDocumentColumns = {
  external_id: string;
  file_name: string;
  type_label: string;
  doc_kind: string;
  shared: boolean;
  uploader_kind: TmsDocumentRead["uploaderKind"];
  byte_length: number;
  source_updated_at: string;
};

// The load's columns and the flags the read itself raises (clocks_disagree on any of its or its
// stops' times, multi_leg past one leg).
export function loadColumnsOf(
  record: TmsLoadRecord,
  labelMap: Record<string, TmsStatusCode>,
  zone: string,
): { columns: MirrorLoadColumns; stops: MirrorStopColumns[]; flags: MirrorFlag[] } {
  const p = kept(record.pickedUp, zone);
  const d = kept(record.delivered, zone);
  const c = kept(record.lastDeliveryCompleted, zone);
  const stops = stopColumnsOf(record, zone);
  const flags: MirrorFlag[] = [];
  if (p.flag || d.flag || c.flag || stops.flagged) flags.push("clocks_disagree");
  if (record.legCount > 1) flags.push("multi_leg");
  return {
    columns: {
      external_id: record.externalId,
      reference: record.reference,
      status_code: codeOf(record.statusLabel, labelMap),
      status_label: record.statusLabel,
      customer_external_id: record.customer?.externalId ?? null,
      driver_external_id: record.driverExternalId,
      truck_unit: record.truckUnit,
      trailer_unit: record.trailerUnit,
      vin: record.vin,
      stop_count: record.stopCount,
      leg_count: record.legCount,
      picked_up_utc: p.utc,
      picked_up_local: p.local,
      picked_up_at: p.at,
      picked_up_day: p.day,
      delivered_utc: d.utc,
      delivered_local: d.local,
      delivered_at: d.at,
      delivered_day: d.day,
      last_completed_utc: c.utc,
      last_completed_local: c.local,
      last_completed_at: c.at,
      last_completed_day: c.day,
      revenue_total_cents: record.revenueTotalCents,
      driver_pay_total_cents: record.driverPayTotalCents,
      source_updated_at: record.updatedAt,
      finalized_at: record.finalizedAt,
    },
    stops: stops.rows,
    flags,
  };
}

// Our order: pickups as given, then deliveries as given (the system keeps no reliable sequence).
function stopColumnsOf(record: TmsLoadRecord, zone: string): { rows: MirrorStopColumns[]; flagged: boolean } {
  let flagged = false;
  const one = (s: TmsStopRecord, ordinal: number, stop_kind: "pickup" | "delivery"): MirrorStopColumns => {
    const a = kept(s.arrived, zone);
    const c = kept(s.completed, zone);
    if (a.flag || c.flag) flagged = true;
    return {
      ordinal,
      stop_kind,
      name: s.name,
      city: s.city,
      state: s.state,
      appt_from_local: s.apptFromLocal,
      appt_to_local: s.apptToLocal,
      appt_from_at: s.apptFromLocal === null ? null : instantOfLocal(s.apptFromLocal, zone),
      appt_to_at: s.apptToLocal === null ? null : instantOfLocal(s.apptToLocal, zone),
      arrived_utc: a.utc,
      arrived_local: a.local,
      arrived_at: a.at,
      completed_utc: c.utc,
      completed_local: c.local,
      completed_at: c.at,
    };
  };
  const rows = [
    ...record.pickups.map((s, i) => one(s, i, "pickup")),
    ...record.deliveries.map((s, i) => one(s, record.pickups.length + i, "delivery")),
  ];
  return { rows, flagged };
}

// History pages read until empty, duplicates across pages dropped by event id (first kept).
export function eventColumnsOf(rows: readonly TmsHistoryRow[], zone: string): MirrorEventColumns[] {
  const seen = new Set<string>();
  const out: MirrorEventColumns[] = [];
  for (const h of rows) {
    if (seen.has(h.externalId)) continue;
    seen.add(h.externalId);
    const r = resolve(h.at, zone);
    out.push({
      external_event_id: h.externalId,
      field: h.field,
      new_value: h.newValue,
      previous_value: h.previousValue,
      changed_by: h.changedBy,
      at_utc: h.at.utc,
      at_local: h.at.local,
      at: r.at,
      day: r.day,
      clock_flag: r.flag,
    });
  }
  return out;
}

export function lineColumnsOf(lines: readonly TmsLineItem[]): MirrorLineColumns[] {
  const seen = new Set<string>();
  return lines
    .filter((l) => (seen.has(l.externalId) ? false : (seen.add(l.externalId), true)))
    .map((l) => ({
      external_id: l.externalId,
      item_group: l.group,
      type_label: l.typeLabel,
      description: l.description,
      amount_cents: l.amountCents,
    }));
}

// A placeholder row (an empty file) is never mirrored.
export function documentColumnsOf(docs: readonly TmsDocumentRead[]): MirrorDocumentColumns[] {
  const seen = new Set<string>();
  return docs
    .filter((d) => d.byteLength > 0)
    .filter((d) => (seen.has(d.externalId) ? false : (seen.add(d.externalId), true)))
    .map((d) => ({
      external_id: d.externalId,
      file_name: d.fileName,
      type_label: d.typeLabel,
      doc_kind: docKindOf(d.typeLabel),
      shared: d.shared,
      uploader_kind: d.uploaderKind,
      byte_length: d.byteLength,
      source_updated_at: d.updatedAt,
    }));
}
