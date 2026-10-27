import type {
  CustomerRow,
  DriverRow,
  FuelPurchaseRow,
  LoadAccessorialRow,
  LoadRow,
  PayItemRow,
} from "../data/rows";
import type {
  ConfidenceField,
  DocumentRead,
  FieldCheck,
  FieldStatus,
  MatchFound,
  MatchNote,
  MatchResult,
} from "./types";

// A document's reading compared with the records, by whole values only: a string equals another
// after trimming, collapsing spaces and upper-casing, an integer equals another integer, and
// nothing is ever matched by a part of a value. Pure: candidates.ts reads the records first.
//
// The match only reports. It says what a person may propose (supports), and only when every
// field that proposal needs agrees with the record; anything low-confidence, missing or
// different leaves supports null and the page says a person should look.

export type Candidates = {
  timeZone: string;
  // The load the document names, by its whole load number. Null when it names none or no load
  // has that number. More than one is impossible (load numbers are unique) and is refused.
  load: LoadRow | null;
  loadMatches: number;
  customer: CustomerRow | null;
  loadDriver: DriverRow | null;
  accessorials: LoadAccessorialRow[];
  // Drivers whose truck unit is the one the document names.
  truckDrivers: DriverRow[];
  // Pay items and fuel purchases of the load's driver and of truckDrivers.
  payItems: PayItemRow[];
  fuelPurchases: FuelPurchaseRow[];
};

// Loads in these statuses can still take a missing rate (invoiced and cancelled cannot).
export const RATE_FILL_STATUSES: readonly LoadRow["status"][] = ["planned", "in_transit", "delivered"];

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function norm(s: string | null): string | null {
  if (s === null) return null;
  const out = s.trim().replace(/\s+/g, " ").toUpperCase();
  return out === "" ? null : out;
}

// 10/27/2026 to 2026-10-27, or null for anything else (a real calendar day only).
export function isoFromMmddyyyy(s: string | null): string | null {
  if (s === null) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

// 2026-10-27 to 10/27/2026.
export function mmddyyyyOf(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error("not a YYYY-MM-DD date");
  return `${m[2]}/${m[3]}/${m[1]}`;
}

// An instant as a bill of lading prints it: "10/21/2026 7:40 AM EDT" in the carrier's zone.
// Assembled from parts with plain spaces (the formatted string can carry a narrow no-break space).
export function stampOf(instant: string, timeZone: string): { full: string; bare: string } {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) throw new Error("not an instant");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const bare = `${part("month")}/${part("day")}/${part("year")} ${part("hour")}:${part("minute")} ${part(
    "dayPeriod",
  ).toUpperCase()}`;
  return { full: `${bare} ${part("timeZoneName")}`, bare };
}

type Builder = {
  read: DocumentRead;
  fields: FieldCheck[];
  notes: MatchNote[];
};

const low = (read: DocumentRead, f: ConfidenceField) => read.confidence[f] === "low";

function check(
  b: Builder,
  name: string,
  conf: ConfidenceField,
  claim: string | number | null,
  record: string | number | null,
  equal: (a: string | number, r: string | number) => boolean = (a, r) => a === r,
): FieldStatus {
  let status: FieldStatus;
  if (claim === null) status = "not_shown";
  else if (low(b.read, conf)) status = "low_confidence";
  else if (record === null) status = "no_record_value";
  else status = equal(claim, record) ? "same" : "differs";
  b.fields.push({ name, claim, record, status });
  return status;
}

const sameText = (a: string | number, r: string | number) =>
  typeof a === "string" && typeof r === "string" && norm(a) === norm(r);

function found(
  b: Builder,
  rest: Omit<MatchFound, "found" | "fields" | "notes">,
): MatchFound {
  return { found: true, ...rest, fields: b.fields, notes: b.notes };
}

const none = (reason: Extract<MatchResult, { found: false }>["reason"]): MatchResult => ({
  found: false,
  reason,
});

function lumper(read: DocumentRead, c: Candidates): MatchResult {
  const f = read.fields;
  const b: Builder = { read, fields: [], notes: [] };
  const acc = c.accessorials.filter((a) => a.load_id === c.load!.id && a.kind === "lumper");
  let row: LoadAccessorialRow | undefined;
  if (acc.length === 1) row = acc[0];
  else {
    const exact = acc.filter((a) => a.amount_cents === f.totalCents);
    if (exact.length !== 1) return none(acc.length === 0 ? "no_record" : "ambiguous");
    row = exact[0];
  }
  const load = c.load!;
  const sameLoad = check(b, "load_number", "load_number", f.loadNumber, load.load_number, sameText);
  const total = check(b, "total_cents", "total_cents", f.totalCents, row.amount_cents);
  const date = check(
    b,
    "date",
    "date_mmddyyyy",
    f.date,
    load.delivered_on === null ? null : mmddyyyyOf(load.delivered_on),
    (a, r) => typeof a === "string" && a.trim() === r,
  );
  const truck = check(b, "truck_unit", "truck_unit", f.truckUnit, c.loadDriver?.truck_unit ?? null, sameText);
  const paid = c.payItems.some((p) => p.ref_table === "load_accessorials" && p.ref_id === row.id);
  let supports: MatchFound["supports"] = null;
  if (paid) b.notes.push("reimbursement_found");
  else if (row.paid_by_driver) {
    b.notes.push("reimbursement_missing");
    const agrees = [sameLoad, total, date].every((s) => s === "same") && truck !== "differs";
    if (agrees && load.driver_id !== null) supports = "missing_reimbursement";
  }
  return found(b, {
    table: "load_accessorials",
    id: row.id,
    humanRef: load.load_number,
    loadId: load.id,
    driverId: load.driver_id,
    supports,
  });
}

function truckIds(c: Candidates): Set<string> {
  return new Set(c.truckDrivers.map((d) => d.id));
}

function truckOf(c: Candidates, driverId: string): string | null {
  return c.truckDrivers.find((d) => d.id === driverId)?.truck_unit ?? null;
}

function toll(read: DocumentRead, c: Candidates): MatchResult {
  const f = read.fields;
  const iso = isoFromMmddyyyy(f.date);
  const drivers = truckIds(c);
  if (iso === null || drivers.size === 0) return none("no_record");
  const sameDay = c.payItems.filter(
    (p) => p.kind === "reimbursement" && p.subkind === "toll" && p.item_date === iso && drivers.has(p.driver_id),
  );
  const exact = sameDay.filter((p) => p.amount_cents === f.totalCents);
  const pick = exact.length === 1 ? exact[0] : exact.length === 0 && sameDay.length === 1 ? sameDay[0] : null;
  if (!pick) return none(exact.length > 1 || sameDay.length > 1 ? "ambiguous" : "no_record");
  const b: Builder = { read, fields: [], notes: [] };
  check(b, "total_cents", "total_cents", f.totalCents, pick.amount_cents);
  check(b, "date", "date_mmddyyyy", f.date, mmddyyyyOf(pick.item_date), (a, r) => typeof a === "string" && a.trim() === r);
  check(b, "truck_unit", "truck_unit", f.truckUnit, truckOf(c, pick.driver_id), sameText);
  return found(b, {
    table: "pay_items",
    id: pick.id,
    humanRef: pick.item_ref,
    loadId: null,
    driverId: pick.driver_id,
    supports: null,
  });
}

function fuel(read: DocumentRead, c: Candidates): MatchResult {
  const f = read.fields;
  const iso = isoFromMmddyyyy(f.date);
  const drivers = truckIds(c);
  if (iso === null || drivers.size === 0) return none("no_record");
  const b: Builder = { read, fields: [], notes: [] };
  if (f.priceCents !== null && f.gallonsMilli !== null && f.totalCents !== null) {
    const computed = Math.round((f.priceCents * f.gallonsMilli) / 1000);
    b.notes.push(Number.isSafeInteger(computed) && computed === f.totalCents ? "arithmetic_checks" : "arithmetic_off");
  }
  const sameDate = (a: string | number, r: string | number) => typeof a === "string" && a.trim() === r;
  const sameDay = c.fuelPurchases.filter((p) => p.purchased_on === iso && drivers.has(p.driver_id));
  const exact = sameDay.filter((p) => p.amount_cents === f.totalCents);
  // Fuel the driver paid for and was reimbursed as a pay item, not bought on the company card.
  const items = c.payItems.filter(
    (p) =>
      p.kind === "reimbursement" &&
      p.subkind === "fuel" &&
      p.item_date === iso &&
      drivers.has(p.driver_id) &&
      p.amount_cents === f.totalCents,
  );
  if (exact.length + items.length > 1) return none("ambiguous");
  if (items.length === 1) {
    const item = items[0];
    b.notes.push("fuel_reimbursement_matched");
    check(b, "total_cents", "total_cents", f.totalCents, item.amount_cents);
    check(b, "date", "date_mmddyyyy", f.date, mmddyyyyOf(item.item_date), sameDate);
    check(b, "truck_unit", "truck_unit", f.truckUnit, truckOf(c, item.driver_id), sameText);
    return found(b, {
      table: "pay_items",
      id: item.id,
      humanRef: item.item_ref,
      loadId: null,
      driverId: item.driver_id,
      supports: null,
    });
  }
  // The exact purchase, or the one purchase that day for that truck (its amount then differs).
  const purchase = exact.length === 1 ? exact[0] : sameDay.length === 1 ? sameDay[0] : null;
  if (!purchase) return none(sameDay.length > 1 ? "ambiguous" : "no_record");
  check(b, "total_cents", "total_cents", f.totalCents, purchase.amount_cents);
  check(b, "date", "date_mmddyyyy", f.date, mmddyyyyOf(purchase.purchased_on), sameDate);
  check(b, "truck_unit", "truck_unit", f.truckUnit, truckOf(c, purchase.driver_id), sameText);
  check(b, "gallons_milli", "gallons_milli", f.gallonsMilli, purchase.gallons_milli);
  return found(b, {
    table: "fuel_purchases",
    id: purchase.id,
    humanRef: purchase.purchase_ref,
    loadId: purchase.load_id,
    driverId: purchase.driver_id,
    supports: null,
  });
}

function rateConfirmation(read: DocumentRead, c: Candidates): MatchResult {
  const f = read.fields;
  const load = c.load!;
  const b: Builder = { read, fields: [], notes: [] };
  const statuses = {
    loadNumber: check(b, "load_number", "load_number", f.loadNumber, load.load_number, sameText),
    miles: check(b, "loaded_miles", "loaded_miles", f.loadedMiles, load.loaded_miles),
    customer: check(b, "customer_name", "customer_name", f.customerName, c.customer?.name ?? null, sameText),
    linehaul: check(b, "linehaul_cents", "linehaul_cents", f.linehaulCents, load.linehaul_cents),
    fsc: check(b, "fuel_surcharge_cents", "fuel_surcharge_cents", f.fuelSurchargeCents, load.fuel_surcharge_cents),
  };
  b.fields.push({
    name: "rate_per_mile_cents",
    claim: f.ratePerMileCents,
    record: null,
    status: f.ratePerMileCents === null ? "not_shown" : low(read, "rate_per_mile_cents") ? "low_confidence" : "no_record_value",
  });
  if (load.linehaul_cents === null) b.notes.push("record_has_no_rate");
  let adds = false;
  if (f.ratePerMileCents !== null && f.loadedMiles !== null && f.linehaulCents !== null) {
    adds = f.ratePerMileCents * f.loadedMiles === f.linehaulCents;
    b.notes.push(adds ? "arithmetic_checks" : "arithmetic_off");
  }
  const sure = (["load_number", "loaded_miles", "rate_per_mile_cents", "linehaul_cents", "fuel_surcharge_cents"] as const)
    .every((k) => !low(read, k));
  const supports =
    load.linehaul_cents === null &&
    RATE_FILL_STATUSES.includes(load.status) &&
    adds &&
    sure &&
    f.fuelSurchargeCents !== null &&
    statuses.loadNumber === "same" &&
    statuses.miles === "same" &&
    statuses.customer !== "differs" &&
    statuses.fsc !== "differs"
      ? "load_rate_fill"
      : null;
  return found(b, {
    table: "loads",
    id: load.id,
    humanRef: load.load_number,
    loadId: load.id,
    driverId: load.driver_id,
    supports,
  });
}

const STOP_FIELDS = [
  { role: "pickup", at: "arrived", column: "pickup_arrived_at", name: "pickup_arrived" },
  { role: "pickup", at: "departed", column: "pickup_departed_at", name: "pickup_departed" },
  { role: "delivery", at: "arrived", column: "delivery_arrived_at", name: "delivery_arrived" },
  { role: "delivery", at: "departed", column: "delivery_departed_at", name: "delivery_departed" },
] as const;

function dockMs(arrived: string | null, departed: string | null): number {
  if (arrived === null || departed === null) return 0;
  return new Date(departed).getTime() - new Date(arrived).getTime();
}

function billOfLading(read: DocumentRead, c: Candidates): MatchResult {
  const f = read.fields;
  const load = c.load!;
  const b: Builder = { read, fields: [], notes: [] };
  check(b, "load_number", "load_number", f.loadNumber, load.load_number, sameText);
  for (const s of STOP_FIELDS) {
    const stop = f.stops.find((x) => x.role === s.role);
    const claim = stop ? stop[s.at] : null;
    const instant = load[s.column];
    const stamp = instant === null ? null : stampOf(instant, c.timeZone);
    check(b, s.name, "stops", claim, stamp?.full ?? null, (a) => {
      const n = typeof a === "string" ? norm(a) : null;
      return n !== null && stamp !== null && (n === stamp.full || n === stamp.bare);
    });
  }
  const detained =
    dockMs(load.pickup_arrived_at, load.pickup_departed_at) > TWO_HOURS_MS ||
    dockMs(load.delivery_arrived_at, load.delivery_departed_at) > TWO_HOURS_MS;
  const detentionOnLoad = c.accessorials.some((a) => a.load_id === load.id && a.kind === "detention");
  if (detained && !detentionOnLoad) b.notes.push("no_detention_recorded");
  return found(b, {
    table: "loads",
    id: load.id,
    humanRef: load.load_number,
    loadId: load.id,
    driverId: load.driver_id,
    supports: null,
  });
}

// The fields each kind cannot be matched without; a low confidence on any of them is no match.
const NEEDS: Record<string, readonly ConfidenceField[]> = {
  lumper_receipt: ["load_number", "total_cents", "date_mmddyyyy"],
  toll_receipt: ["total_cents", "date_mmddyyyy", "truck_unit"],
  fuel_receipt: ["total_cents", "date_mmddyyyy", "truck_unit"],
  rate_confirmation: ["load_number"],
  bill_of_lading: ["load_number"],
};

const BY_LOAD = new Set(["lumper_receipt", "rate_confirmation", "bill_of_lading"]);

export function matchDocument(read: DocumentRead, c: Candidates): MatchResult {
  const needs = NEEDS[read.kind];
  if (!needs) return none("no_load");
  if (needs.some((f) => low(read, f))) return none("low_confidence");
  if (BY_LOAD.has(read.kind)) {
    if (norm(read.fields.loadNumber) === null) return none("no_load");
    if (c.loadMatches > 1) return none("ambiguous");
    if (!c.load) return none("no_record");
  } else if (read.fields.totalCents === null || norm(read.fields.truckUnit) === null) {
    return none("no_record");
  }
  switch (read.kind) {
    case "lumper_receipt":
      return read.fields.totalCents === null ? none("no_record") : lumper(read, c);
    case "toll_receipt":
      return toll(read, c);
    case "fuel_receipt":
      return fuel(read, c);
    case "rate_confirmation":
      return rateConfirmation(read, c);
    case "bill_of_lading":
      return billOfLading(read, c);
    default:
      return none("no_load");
  }
}
