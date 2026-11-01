import { flags } from "../../config/flags";
import { serveLoad, type SynLoad, type SynWorld } from "../adapters/tms-source/synthetic";
import type {
  CustomerRow,
  DriverIdentityRow,
  DriverRow,
  InvoiceRow,
  LoadAccessorialRow,
  LoadRow,
  TenantRows,
  TmsLoadRow,
} from "../data/rows";
import { documentColumnsOf, eventColumnsOf, lineColumnsOf, loadColumnsOf } from "../tms/mirror";
import { syntheticLabelMap } from "../tms/status";
import { parseInstant, type LocalDate } from "../time/local-date";
import { instantAt } from "./calendar";
import { addMockLoad, emptyMockStore, type MockStore } from "./mock-tms";
import { Rng } from "./prng";

// TMS-MIRROR (0075): the dispatch mirror as the synthetic feed serves it at the seeded instant
// (the anchor's local midnight), built from the plan's own loads, customers, driver identities
// and accessorials by the same generator and the same column mapping the sync uses, from its own
// id stream (`<seed>:tms`) so no other row's id moves. Every snapshot row is seeded: the desk
// never moves a load on a seeded status event. The connection's feed floor is the same instant,
// so the feed never reads earlier than the snapshot.
//
// MOCK-TMS (0088): the sample dispatch system's store is the same served feed (seed/mock-tms.ts),
// from its own id stream (`<seed>:mock-tms`). While flags.mockTms is on the connection reads it
// (system `mock`, a 2 minute cool-off so a finalize there drafts its card within a demo); while
// off the connection stays the synthetic feed and the store is filled but unread.

type Input = {
  seed: string;
  slug: string;
  zone: string;
  anchor: LocalDate;
  rows: Pick<TenantRows, "customers" | "drivers" | "driver_identities" | "loads" | "load_accessorials" | "invoices">;
};

export type TmsSnapshot = Pick<
  TenantRows,
  "tms_connections" | "tms_parties" | "tms_loads" | "tms_stops" | "tms_status_events" | "tms_line_items" | "tms_documents"
> &
  MockStore;

export const SEED_LOOKBACK_HOURS = 4;
export const SEED_COOLOFF_MINUTES = 30;
export const MOCK_COOLOFF_MINUTES = 2;

// The feed's facts for one plan load: the same fields the live feed reads from the tables.
export function synLoadOf(
  load: LoadRow,
  customers: ReadonlyMap<string, CustomerRow>,
  drivers: ReadonlyMap<string, DriverRow>,
  identities: ReadonlyMap<string, string>,
  accessorials: readonly LoadAccessorialRow[],
  invoices: readonly InvoiceRow[],
): SynLoad {
  const customer = load.customer_id ? customers.get(load.customer_id) : undefined;
  const driver = load.driver_id ? drivers.get(load.driver_id) : undefined;
  const issued = invoices
    .filter((v) => v.load_id === load.id && v.status !== "void")
    .map((v) => v.issued_on)
    .sort();
  return {
    loadNumber: load.load_number,
    status: load.status,
    pickupOn: load.pickup_on,
    deliveredAt: load.delivered_at,
    loadedMiles: load.loaded_miles,
    linehaulCents: load.linehaul_cents,
    fuelSurchargeCents: load.fuel_surcharge_cents,
    pickupArrivedAt: load.pickup_arrived_at,
    pickupDepartedAt: load.pickup_departed_at,
    deliveryArrivedAt: load.delivery_arrived_at,
    originCity: load.origin_city,
    originState: load.origin_state,
    destCity: load.dest_city,
    destState: load.dest_state,
    customer: customer ? { code: customer.code, name: customer.name } : null,
    driverExternalId: load.driver_id ? (identities.get(load.driver_id) ?? null) : null,
    truckUnit: driver?.truck_unit ?? null,
    accessorials: accessorials
      .filter((a) => a.load_id === load.id)
      .map((a) => ({ kind: a.kind, seq: a.seq, amountCents: a.amount_cents, description: a.description })),
    invoiceIssuedOn: issued[0] ?? null,
  };
}

export function buildTmsSnapshot(input: Input): TmsSnapshot {
  const rng = new Rng(`${input.seed}:tms`);
  const mockRng = new Rng(`${input.seed}:mock-tms`);
  const onMock = flags.mockTms.enabled === true;
  const { zone, rows } = input;
  const world: SynWorld = { slug: input.slug, zone };
  const floorAt = instantAt(input.anchor, 0, 0, zone);
  const floorMs = parseInstant(floorAt);
  const labelMap = syntheticLabelMap();

  const customers = new Map(rows.customers.map((c) => [c.id, c]));
  const drivers = new Map(rows.drivers.map((d) => [d.id, d]));
  const identities = new Map<string, string>();
  for (const i of [...rows.driver_identities].sort((a, b) => (a.external_id < b.external_id ? -1 : 1))) {
    if (i.system === "tms" && !identities.has(i.driver_id)) identities.set(i.driver_id, i.external_id);
  }
  const byNumber = new Map<string, LoadRow[]>();
  for (const l of rows.loads) byNumber.set(l.load_number, [...(byNumber.get(l.load_number) ?? []), l]);

  const out: TmsSnapshot = {
    tms_connections: [
      {
        id: rng.uuid(),
        system: onMock ? "mock" : "synthetic",
        label_map: labelMap,
        lookback_hours: SEED_LOOKBACK_HOURS,
        finalize_cooloff_minutes: onMock ? MOCK_COOLOFF_MINUTES : SEED_COOLOFF_MINUTES,
        demo_faults: {},
        feed_floor_at: floorAt,
      },
    ],
    tms_parties: [],
    tms_loads: [],
    tms_stops: [],
    tms_status_events: [],
    tms_line_items: [],
    tms_documents: [],
    ...emptyMockStore(),
  };
  const mockTrucks = new Set<string>();

  const ordered = [...rows.loads].sort((a, b) => (a.load_number < b.load_number ? -1 : a.load_number > b.load_number ? 1 : 0));
  const partyDrivers = new Set<string>();
  const partyCustomers = new Set<string>();
  for (const load of ordered) {
    const syn = synLoadOf(load, customers, drivers, identities, rows.load_accessorials, rows.invoices);
    const served = serveLoad(world, syn, floorMs);
    if (served === null) continue;
    addMockLoad(out, mockRng, served);
    const mapped = loadColumnsOf(served.record, labelMap, zone);
    const linked = byNumber.get(served.record.reference)?.length === 1 ? load.id : null;
    const flags = [...mapped.flags, ...(linked === null ? ["unlinked" as const] : [])];
    const finalized = mapped.columns.finalized_at;
    const row: TmsLoadRow = {
      id: rng.uuid(),
      ...mapped.columns,
      load_id: linked,
      received_at: floorAt,
      recheck_after: null,
      // A load already finalized at the snapshot counts its cool-off read as done.
      finalized_seen_at: finalized,
      listed_at: null,
      flags,
      seeded: true,
    };
    out.tms_loads.push(row);
    for (const s of mapped.stops) out.tms_stops.push({ id: rng.uuid(), tms_load_id: row.id, ...s });
    for (const e of eventColumnsOf(served.history, zone)) {
      out.tms_status_events.push({ id: rng.uuid(), tms_load_id: row.id, ...e, received_at: floorAt, seeded: true });
    }
    for (const l of lineColumnsOf(served.lines)) out.tms_line_items.push({ id: rng.uuid(), tms_load_id: row.id, ...l });
    for (const d of documentColumnsOf(served.documents)) {
      out.tms_documents.push({ id: rng.uuid(), tms_load_id: row.id, ...d, review_state: "unreviewed", first_seen_at: floorAt });
    }
    const customer = load.customer_id ? customers.get(load.customer_id) : undefined;
    if (customer && !partyCustomers.has(customer.code)) {
      partyCustomers.add(customer.code);
      out.tms_parties.push({
        id: rng.uuid(),
        kind: "customer",
        external_id: customer.code,
        name: customer.name,
        unit: null,
        vin: null,
        customer_id: customer.id,
        driver_id: null,
        received_at: floorAt,
        seeded: true,
      });
      out.mock_tms_parties.push({ id: mockRng.uuid(), kind: "customer", external_id: customer.code, name: customer.name, unit: null, vin: null });
    }
    const ext = served.record.driverExternalId;
    const driver = load.driver_id ? drivers.get(load.driver_id) : undefined;
    if (ext !== null && driver && !partyDrivers.has(ext)) {
      partyDrivers.add(ext);
      out.tms_parties.push({
        id: rng.uuid(),
        kind: "driver",
        external_id: ext,
        name: `${driver.first_name} ${driver.last_name}`,
        unit: driver.truck_unit,
        vin: null,
        customer_id: null,
        driver_id: driver.id,
        received_at: floorAt,
        seeded: true,
      });
      out.mock_tms_parties.push({
        id: mockRng.uuid(),
        kind: "driver",
        external_id: ext,
        name: `${driver.first_name} ${driver.last_name}`,
        unit: driver.truck_unit,
        vin: null,
      });
    }
    const truck = served.record.truckUnit;
    if (truck !== null && !mockTrucks.has(truck)) {
      mockTrucks.add(truck);
      out.mock_tms_parties.push({ id: mockRng.uuid(), kind: "truck", external_id: truck, name: `Truck ${truck}`, unit: truck, vin: null });
    }
  }
  return out;
}
