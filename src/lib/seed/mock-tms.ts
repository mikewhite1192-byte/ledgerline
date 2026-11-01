import type { SynServed } from "../adapters/tms-source/synthetic";
import type { TwoClocks } from "../adapters/tms-source/types";
import type { MockTmsDocumentRow, MockTmsEventRow, MockTmsLineRow, MockTmsLoadRow, MockTmsStopRow, TenantRows } from "../data/rows";
import type { Rng } from "./prng";

// MOCK-TMS (0088): the sample dispatch system's board as the synthetic feed serves it at the
// seeded instant, one load at a time, so the store a person clicks through starts as the mirror's
// seeded snapshot, id for id: the load, its stops, its history (seq in time order), its lines and
// its documents keep the generator's ids. The store keeps one instant per time (both clocks agree
// on a clean feed). Ids come from the caller's own stream (`<seed>:mock-tms`), so no other row's
// id moves.

export type MockStore = Pick<
  TenantRows,
  "mock_tms_parties" | "mock_tms_loads" | "mock_tms_stops" | "mock_tms_events" | "mock_tms_lines" | "mock_tms_documents"
>;

export const emptyMockStore = (): MockStore => ({
  mock_tms_parties: [],
  mock_tms_loads: [],
  mock_tms_stops: [],
  mock_tms_events: [],
  mock_tms_lines: [],
  mock_tms_documents: [],
});

const utcOf = (c: TwoClocks | null): string | null => c?.utc ?? null;

// One served load as store rows, added to `out`.
export function addMockLoad(out: MockStore, rng: Rng, served: SynServed, seeded = true): MockTmsLoadRow {
  const r = served.record;
  const load: MockTmsLoadRow = {
    id: rng.uuid(),
    external_id: r.externalId,
    reference: r.reference,
    status_label: r.statusLabel,
    customer_external_id: r.customer?.externalId ?? null,
    customer_name: r.customer?.name ?? null,
    driver_external_id: r.driverExternalId,
    truck_unit: r.truckUnit,
    trailer_unit: r.trailerUnit,
    vin: r.vin,
    picked_up_at: utcOf(r.pickedUp),
    delivered_at: utcOf(r.delivered),
    last_completed_at: utcOf(r.lastDeliveryCompleted),
    finalized_at: r.finalizedAt,
    created_at: served.list.createdAt,
    updated_at: served.list.updatedAt,
    seeded,
  };
  out.mock_tms_loads.push(load);
  const stops = [
    ...r.pickups.map((s) => ({ s, kind: "pickup" as const })),
    ...r.deliveries.map((s) => ({ s, kind: "delivery" as const })),
  ];
  stops.forEach(({ s, kind }, ordinal) => {
    const row: MockTmsStopRow = {
      id: rng.uuid(),
      mock_load_id: load.id,
      ordinal,
      stop_kind: kind,
      name: s.name,
      city: s.city,
      state: s.state,
      appt_from_local: s.apptFromLocal,
      appt_to_local: s.apptToLocal,
      arrived_at: utcOf(s.arrived),
      completed_at: utcOf(s.completed),
    };
    out.mock_tms_stops.push(row);
  });
  served.history.forEach((h, i) => {
    const row: MockTmsEventRow = {
      id: rng.uuid(),
      mock_load_id: load.id,
      seq: i + 1,
      external_id: h.externalId,
      field: h.field,
      new_value: h.newValue,
      previous_value: h.previousValue,
      changed_by: h.changedBy,
      at: h.at.utc ?? load.created_at,
    };
    out.mock_tms_events.push(row);
  });
  for (const l of served.lines) {
    const row: MockTmsLineRow = {
      id: rng.uuid(),
      mock_load_id: load.id,
      external_id: l.externalId,
      item_group: l.group,
      type_label: l.typeLabel,
      description: l.description,
      amount_cents: l.amountCents,
    };
    out.mock_tms_lines.push(row);
  }
  for (const d of served.documents) {
    const row: MockTmsDocumentRow = {
      id: rng.uuid(),
      mock_load_id: load.id,
      external_id: d.externalId,
      file_name: d.fileName,
      type_label: d.typeLabel,
      shared: d.shared,
      uploader_kind: d.uploaderKind,
      byte_length: d.byteLength,
      updated_at: d.updatedAt,
    };
    out.mock_tms_documents.push(row);
  }
  return load;
}
