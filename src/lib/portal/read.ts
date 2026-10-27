import type { Queryable } from "../db";
import { iso } from "./sql";
import { isFacilityZone, stampText, type FacilityZone } from "./zones";

// The portal pages' reads, inside a portal tenant transaction (tenant.ts). References and load
// numbers match whole values only.

export const REFERENCE = /^FFE-[0-9]{6}$/;
const LOAD_NUMBER = /^[A-Za-z0-9-]{1,40}$/;

export type PortalLoadLine = {
  reference: string;
  loadNumber: string;
  consignee: string;
  destination: string;
  podStatus: "available" | "pending";
};

export type PortalLoadDetail = PortalLoadLine & {
  shipper: string;
  scheduledWindow: string;
  checkedIn: string | null;
  checkedOut: string | null;
  podSignedBy: string | null;
  notes: string | null;
};

type LineRow = {
  reference: string;
  load_number: string;
  consignee_name: string;
  consignee_city: string;
  consignee_state: string;
  pod_status: "available" | "pending";
};

const LINE_COLUMNS =
  "p.reference, l.load_number, p.consignee_name, p.consignee_city, p.consignee_state, p.pod_status";

function line(r: LineRow): PortalLoadLine {
  return {
    reference: r.reference,
    loadNumber: r.load_number,
    consignee: r.consignee_name,
    destination: `${r.consignee_city}, ${r.consignee_state}`,
    podStatus: r.pod_status,
  };
}

// A search box value: a broker reference (FFE-123456) or the carrier's own load number, whole.
export async function findPortalLoads(q: Queryable, raw: string): Promise<PortalLoadLine[]> {
  const query = raw.trim();
  if (!LOAD_NUMBER.test(query)) return [];
  const rows = await q.query<LineRow>(
    `SELECT ${LINE_COLUMNS} FROM portal_loads p` +
      " JOIN loads l ON l.tenant_id = p.tenant_id AND l.id = p.load_id" +
      " WHERE p.tenant_id = current_tenant_id() AND (p.reference = $1 OR l.load_number = $2)" +
      " ORDER BY p.reference LIMIT 20",
    [query.toUpperCase(), query],
  );
  return rows.map(line);
}

type DetailRow = LineRow & {
  shipper_name: string;
  scheduled_from: string;
  scheduled_to: string;
  delivery_checked_in_at: string | null;
  delivery_checked_out_at: string | null;
  facility_time_zone: string;
  pod_signed_by: string | null;
  notes: string | null;
};

export async function portalLoadByReference(q: Queryable, raw: string): Promise<PortalLoadDetail | null> {
  if (!REFERENCE.test(raw)) return null;
  const rows = await q.query<DetailRow>(
    `SELECT ${LINE_COLUMNS}, p.shipper_name, ${iso("p.scheduled_from")}, ${iso("p.scheduled_to")},` +
      ` ${iso("p.delivery_checked_in_at")}, ${iso("p.delivery_checked_out_at")},` +
      " p.facility_time_zone, p.pod_signed_by, p.notes" +
      " FROM portal_loads p JOIN loads l ON l.tenant_id = p.tenant_id AND l.id = p.load_id" +
      " WHERE p.tenant_id = current_tenant_id() AND p.reference = $1",
    [raw],
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  if (!isFacilityZone(r.facility_time_zone)) return null;
  const zone: FacilityZone = r.facility_time_zone;
  return {
    ...line(r),
    shipper: r.shipper_name,
    scheduledWindow: `${stampText(r.scheduled_from, zone)} to ${stampText(r.scheduled_to, zone)}`,
    checkedIn: r.delivery_checked_in_at ? stampText(r.delivery_checked_in_at, zone) : null,
    checkedOut: r.delivery_checked_out_at ? stampText(r.delivery_checked_out_at, zone) : null,
    podSignedBy: r.pod_signed_by,
    notes: r.notes,
  };
}

// The signed POD's bytes, or null when the load has none.
export async function portalPod(q: Queryable, raw: string): Promise<Uint8Array | null> {
  if (!REFERENCE.test(raw)) return null;
  const rows = await q.query<{ pdf: string | null }>(
    "SELECT encode(pod_pdf, 'base64') AS pdf FROM portal_loads" +
      " WHERE tenant_id = current_tenant_id() AND reference = $1 AND pod_status = 'available'",
    [raw],
  );
  if (rows.length !== 1 || !rows[0].pdf) return null;
  return new Uint8Array(Buffer.from(rows[0].pdf, "base64"));
}
