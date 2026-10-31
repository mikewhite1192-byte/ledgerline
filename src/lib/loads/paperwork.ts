import { isoFromMmddyyyy, norm } from "../documents/match";
import type { DocumentRead, FieldCheck, ReadStatus, StopClaim } from "../documents/types";
import { instantAt } from "../seed/calendar";
import { daysBetween, type Instant, type LocalDate } from "../time/local-date";

// "Paperwork in" for one load, decided by code from the documents Muse Spark already read and the
// comparison code already stored (src/lib/documents/match.ts, whole load number only). Pure: no
// model, no clock, no database.
//
//   rate con     a read rate_confirmation matched to the load whose load number and linehaul both
//                read the same as the load's; or the load's rate is already filled (rated).
//   pickup BOL   a read bill_of_lading matched to the load, dated pickup_on - 1 to pickup_on + 2,
//                whose stops claim names the pickup stop whenever it names any stop.
//   POD          a second such bill of lading, dated after the pickup paper (or the same day with a
//                stops claim naming the delivery stop), not before pickup_on and at most 14 days
//                after it (loads has no planned delivery date, 0004, so the window hangs off
//                pickup_on). With no pickup paper in, a bill of lading whose stops claim names the
//                delivery stop and not the pickup one, in the same window, is the POD: a load a
//                driver's text or a person already moved to in transit can still be delivered on its
//                paper (src/lib/loads/movement.ts never delivers a planned load on a POD alone).
//
// A read that is unreadable, out of budget or still pending never counts, nor does a comparison
// with any field that differs, nor a date or a stops claim the reading marked low. pickupIn means a
// pickup paper is in and deliveryIn a POD is in; the advance (a later PR) also needs rated.

export type PaperLoad = { id: string; pickup_on: LocalDate; linehaul_cents: number | null };

export type PaperDocument = {
  id: string;
  readStatus: ReadStatus;
  // documents.document_kind.
  kind: string | null;
  // The stored reading parsed back (src/lib/documents/schema.ts parseRead), or null.
  read: DocumentRead | null;
  // The stored comparison (documents.match), as stored: a MatchResult, or {} when none ran.
  match: unknown;
  createdAt: Instant;
};

export type MissingPaper = "rate_confirmation" | "pickup_bol" | "pod";

export type Paperwork = {
  rateCon: string | null;
  pickupBol: string | null;
  pod: string | null;
  rated: boolean;
  pickupIn: boolean;
  deliveryIn: boolean;
  missing: MissingPaper[];
};

// Why one bill of lading did not count, as a category (never the reading's own words).
export type BolRefusal =
  | "not_read"
  | "not_matched"
  | "field_differs"
  | "no_date"
  | "low_confidence"
  | "date_out_of_window"
  | "stop_unclear"
  // A delivery paper for a planned load with no pickup paper in.
  | "no_pickup_paper";

export const PICKUP_WINDOW = { before: 1, after: 2 } as const;
export const POD_WINDOW_DAYS = 14;

type Bol = { id: string; date: LocalDate; createdAt: string; pickup: boolean; delivery: boolean; doc: PaperDocument };

function fieldsOf(match: unknown, loadId: string): FieldCheck[] | null {
  if (typeof match !== "object" || match === null) return null;
  const m = match as Record<string, unknown>;
  if (m.found !== true || m.table !== "loads" || m.loadId !== loadId || !Array.isArray(m.fields)) return null;
  return m.fields as FieldCheck[];
}

const statusOf = (fields: FieldCheck[], name: string) => fields.find((f) => f && f.name === name)?.status;

const anyDiffers = (fields: FieldCheck[]) => fields.some((f) => !f || f.status === "differs");

function roles(stops: readonly StopClaim[]): { pickup: boolean; delivery: boolean } {
  return { pickup: stops.some((s) => s.role === "pickup"), delivery: stops.some((s) => s.role === "delivery") };
}

// One bill of lading checked against the load: its parts, or why it does not count.
export function bolOf(load: PaperLoad, doc: PaperDocument): { ok: true; bol: Bol } | { ok: false; reason: BolRefusal } {
  if (doc.readStatus !== "read" || doc.kind !== "bill_of_lading" || doc.read === null || doc.read.kind !== "bill_of_lading") {
    return { ok: false, reason: "not_read" };
  }
  const fields = fieldsOf(doc.match, load.id);
  if (!fields) return { ok: false, reason: "not_matched" };
  if (anyDiffers(fields)) return { ok: false, reason: "field_differs" };
  const read = doc.read;
  if (read.confidence.date_mmddyyyy === "low") return { ok: false, reason: "low_confidence" };
  if (read.fields.stops.length > 0 && read.confidence.stops === "low") return { ok: false, reason: "low_confidence" };
  const date = isoFromMmddyyyy(read.fields.date);
  if (date === null) return { ok: false, reason: "no_date" };
  const r = roles(read.fields.stops);
  return { ok: true, bol: { id: doc.id, date, createdAt: doc.createdAt, pickup: r.pickup, delivery: r.delivery, doc } };
}

// Oldest paper first: by its printed date, then the one that names no delivery, then upload, then id.
function byPaperOrder(a: Bol, b: Bol): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.delivery !== b.delivery) return a.delivery ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function pickupWindowHolds(load: PaperLoad, date: LocalDate): boolean {
  const d = daysBetween(load.pickup_on, date);
  return d >= -PICKUP_WINDOW.before && d <= PICKUP_WINDOW.after;
}

export function podWindowHolds(load: PaperLoad, date: LocalDate): boolean {
  const d = daysBetween(load.pickup_on, date);
  return d >= 0 && d <= POD_WINDOW_DAYS;
}

// Whether a bill of lading can be the pickup paper: in the pickup window, and naming the pickup
// stop when it names any stop.
function canBePickup(load: PaperLoad, b: Bol): boolean {
  const namesAny = b.pickup || b.delivery;
  return pickupWindowHolds(load, b.date) && (!namesAny || b.pickup);
}

function canBePod(load: PaperLoad, b: Bol, pickup: Bol): boolean {
  if (b.id === pickup.id || !podWindowHolds(load, b.date)) return false;
  return b.date > pickup.date || (b.date === pickup.date && b.delivery);
}

// The POD when no pickup paper is in: a paper naming the delivery stop only.
function canBeLonePod(load: PaperLoad, b: Bol): boolean {
  return b.delivery && !b.pickup && podWindowHolds(load, b.date);
}

function rateConCounts(load: PaperLoad, doc: PaperDocument): boolean {
  if (doc.readStatus !== "read" || doc.kind !== "rate_confirmation" || doc.read === null) return false;
  if (doc.read.kind !== "rate_confirmation") return false;
  const fields = fieldsOf(doc.match, load.id);
  if (!fields || anyDiffers(fields)) return false;
  return statusOf(fields, "load_number") === "same" && statusOf(fields, "linehaul_cents") === "same";
}

const byUpload = (a: PaperDocument, b: PaperDocument) =>
  a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function paperworkOf(load: PaperLoad, documents: readonly PaperDocument[]): Paperwork {
  const docs = [...documents].sort(byUpload);
  const rateDoc = docs.find((d) => rateConCounts(load, d)) ?? null;
  const rated = rateDoc !== null || load.linehaul_cents !== null;

  const bols: Bol[] = [];
  for (const d of docs) {
    const r = bolOf(load, d);
    if (r.ok) bols.push(r.bol);
  }
  bols.sort(byPaperOrder);
  const pickup = bols.find((b) => canBePickup(load, b)) ?? null;
  const pod = pickup
    ? (bols.find((b) => canBePod(load, b, pickup)) ?? null)
    : (bols.find((b) => canBeLonePod(load, b)) ?? null);

  const missing: MissingPaper[] = [];
  if (!rated) missing.push("rate_confirmation");
  if (!pickup) missing.push("pickup_bol");
  if (!pod) missing.push("pod");
  return {
    rateCon: rateDoc?.id ?? null,
    pickupBol: pickup?.id ?? null,
    pod: pod?.id ?? null,
    rated,
    pickupIn: pickup !== null,
    deliveryIn: pod !== null,
    missing,
  };
}

// Why a bill of lading for this load counted as neither paper, as a category: the paperwork rules
// above, read for one document. Null when it is the pickup paper or the POD.
export function whyNotCounted(load: PaperLoad, doc: PaperDocument, paper: Paperwork): BolRefusal | null {
  if (doc.id === paper.pickupBol || doc.id === paper.pod) return null;
  const r = bolOf(load, doc);
  if (!r.ok) return r.reason;
  if (!pickupWindowHolds(load, r.bol.date) && !podWindowHolds(load, r.bol.date)) return "date_out_of_window";
  if (paper.pickupBol === null && r.bol.delivery && podWindowHolds(load, r.bol.date)) return "no_pickup_paper";
  return "stop_unclear";
}

const STAMP = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) (AM|PM)(?: [A-Z]{2,5})?$/;

// A stop time as a bill of lading prints it ("10/21/2026 7:40 AM EDT"), read as a wall clock in
// the carrier's zone, as an ISO instant; null for anything else, a time that does not exist or one
// that happens twice. The printed zone letters are not trusted: a stop in another zone is read in
// the carrier's, which can put it an hour or two off; the check below still holds both stamps in
// order.
export function stampInstant(text: string | null, zone: string): Instant | null {
  const n = norm(text);
  if (n === null) return null;
  const m = STAMP.exec(n);
  if (!m) return null;
  const date = isoFromMmddyyyy(`${m[1]}/${m[2]}/${m[3]}`);
  const hour12 = Number(m[4]);
  const minute = Number(m[5]);
  if (date === null || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (m[6] === "PM" ? 12 : 0);
  try {
    return instantAt(date, hour, minute, zone);
  } catch {
    return null;
  }
}

// The arrived and departed times one document's stops claim gives for a stop, both or neither, in
// order (departed never before arrived), or null.
export function stopTimesOf(
  doc: PaperDocument,
  role: StopClaim["role"],
  zone: string,
): { arrivedAt: Instant; departedAt: Instant } | null {
  if (!doc.read || doc.read.confidence.stops === "low") return null;
  const stops = doc.read.fields.stops.filter((s) => s.role === role);
  if (stops.length !== 1) return null;
  const arrivedAt = stampInstant(stops[0].arrived, zone);
  const departedAt = stampInstant(stops[0].departed, zone);
  if (arrivedAt === null || departedAt === null) return null;
  if (Date.parse(departedAt) < Date.parse(arrivedAt)) return null;
  return { arrivedAt, departedAt };
}

// The printed date of a counted bill of lading (the POD's is the delivered_on date).
export function paperDateOf(doc: PaperDocument): LocalDate | null {
  return doc.read ? isoFromMmddyyyy(doc.read.fields.date) : null;
}
