import type { BadgeTone } from "@/components/ui/badge";
import { formatCents } from "@/lib/format/money";
import type {
  ConfidenceField,
  DocumentKind,
  DocumentRead,
  DocumentView,
  FieldStatus,
  MatchNote,
  MatchNone,
  MatchedTable,
  ReadStatus,
} from "@/lib/documents/types";

// Plain-English words for a document's codes. Every sentence is fixed: nothing a model read is
// ever shown as an instruction, only as a value in a table cell.

const KIND_LABELS: Record<DocumentKind, string> = {
  lumper_receipt: "Lumper receipt",
  toll_receipt: "Toll receipt",
  fuel_receipt: "Fuel receipt",
  rate_confirmation: "Rate confirmation",
  bill_of_lading: "Bill of lading",
  other: "Other document",
};

export function kindLabel(kind: DocumentKind | null): string {
  return kind && Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind] : "Not read yet";
}

const READ_STATUS: Record<ReadStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "Reading", tone: "info" },
  read: { label: "Read", tone: "success" },
  unreadable: { label: "Could not read", tone: "warning" },
  budget: { label: "Not read (budget)", tone: "warning" },
};

export function readStatusBadge(view: Pick<DocumentView, "readStatus" | "stalled">): { label: string; tone: BadgeTone } {
  if (view.readStatus === "pending" && view.stalled) return { label: "Read did not finish", tone: "warning" };
  return READ_STATUS[view.readStatus];
}

const FIELD_LABELS: Record<string, string> = {
  vendor: "Vendor",
  price_cents: "Price per gallon",
  load_number: "Load number",
  total_cents: "Total",
  date: "Date",
  truck_unit: "Truck",
  gallons_milli: "Gallons",
  customer_name: "Customer",
  loaded_miles: "Loaded miles",
  linehaul_cents: "Linehaul",
  fuel_surcharge_cents: "Fuel surcharge",
  rate_per_mile_cents: "Rate per mile",
  pickup_arrived: "Pickup arrived",
  pickup_departed: "Pickup departed",
  delivery_arrived: "Delivery arrived",
  delivery_departed: "Delivery departed",
};

export function fieldLabel(name: string): string {
  return Object.hasOwn(FIELD_LABELS, name) ? FIELD_LABELS[name] : "Other field";
}

const CENTS_FIELDS = new Set(["total_cents", "linehaul_cents", "fuel_surcharge_cents"]);

// One compared value as text. Cents become dollars, thousandths of a gallon become gallons, and
// anything that is not the expected type reads as a dash rather than throwing.
export function fieldValue(name: string, value: string | number | null): string {
  if (value === null) return "None";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return "None";
    if (CENTS_FIELDS.has(name)) return formatCents(value);
    if (name === "rate_per_mile_cents") return `${formatCents(value)} a mile`;
    if (name === "price_cents") return `${formatCents(value)} a gallon`;
    if (name === "gallons_milli") return `${(value / 1000).toFixed(3)} gal`;
    if (name === "loaded_miles") return `${value.toLocaleString("en-US")} mi`;
    return String(value);
  }
  return value;
}

const FIELD_STATUS: Record<FieldStatus, { label: string; tone: BadgeTone }> = {
  same: { label: "Same", tone: "success" },
  differs: { label: "Differs", tone: "destructive" },
  no_record_value: { label: "Record has none", tone: "info" },
  low_confidence: { label: "Low confidence", tone: "warning" },
  not_shown: { label: "Not on the document", tone: "neutral" },
};

export function fieldStatusBadge(status: FieldStatus): { label: string; tone: BadgeTone } {
  return Object.hasOwn(FIELD_STATUS, status) ? FIELD_STATUS[status] : { label: "Not compared", tone: "neutral" };
}

const NOTE_SENTENCES: Record<MatchNote, string> = {
  arithmetic_checks: "The document's own arithmetic adds up.",
  arithmetic_off: "The document's own arithmetic does not add up.",
  reimbursement_found: "A matching reimbursement is already on the driver's pay.",
  reimbursement_missing: "No reimbursement for this receipt is on the driver's pay yet.",
  record_has_no_rate: "The load has no rate yet.",
  no_detention_recorded: "The stop times show a long wait, and no detention is recorded on the load.",
  fuel_reimbursement_matched: "This fuel receipt matches a reimbursement on the driver's pay.",
};

// The arithmetic each kind checks, named so the sentence says which numbers were multiplied.
const ARITHMETIC: Partial<Record<DocumentKind, string>> = {
  rate_confirmation: "rate per mile times loaded miles against the linehaul",
  fuel_receipt: "price per gallon times gallons against the total",
};

export function noteSentence(note: MatchNote, kind: DocumentKind | null): string | null {
  if (!Object.hasOwn(NOTE_SENTENCES, note)) return null;
  const what = kind ? ARITHMETIC[kind] : undefined;
  if (what && (note === "arithmetic_checks" || note === "arithmetic_off")) {
    return `${NOTE_SENTENCES[note].replace(/\.$/, "")} (${what}).`;
  }
  return NOTE_SENTENCES[note];
}

const NONE_SENTENCES: Record<MatchNone["reason"], string> = {
  no_load: "No load number was read from this document.",
  no_record: "No record matches this document.",
  low_confidence: "The key fields were read with low confidence, so nothing was compared.",
  unreadable: "The document was not read, so nothing was compared.",
  ambiguous: "More than one record could match, so nothing was picked.",
};

export function noneSentence(reason: MatchNone["reason"], kind: DocumentKind | null): string {
  if (kind === "other") return "This kind of document is not compared with the records.";
  return Object.hasOwn(NONE_SENTENCES, reason) ? NONE_SENTENCES[reason] : "Nothing was compared.";
}

const TABLE_LABELS: Record<MatchedTable, string> = {
  loads: "Load",
  load_accessorials: "Extra charge",
  pay_items: "Pay item",
  fuel_purchases: "Fuel purchase",
};

// The matched record's name, "Load L-10421". Shown as text: record pages are not built yet.
export function matchedLabel(view: Pick<DocumentView, "match">): string | null {
  const m = view.match;
  if (!m || !m.found) return null;
  const kind = Object.hasOwn(TABLE_LABELS, m.table) ? TABLE_LABELS[m.table] : "Record";
  return `${kind} ${m.humanRef}`;
}

// The name a list row leads with: the vendor on a receipt, the customer on a rate confirmation.
export function partyOf(view: Pick<DocumentView, "read">): string | null {
  const f = view.read?.fields;
  if (!f) return null;
  return f.vendor ?? f.customerName ?? null;
}

export type ClaimRow = { key: string; name: string; value: string; low: boolean };

const CLAIM_ORDER: { name: string; conf: ConfidenceField; pick: (f: DocumentRead["fields"]) => string | number | null }[] = [
  { name: "vendor", conf: "vendor", pick: (f) => f.vendor },
  { name: "customer_name", conf: "customer_name", pick: (f) => f.customerName },
  { name: "date", conf: "date_mmddyyyy", pick: (f) => f.date },
  { name: "load_number", conf: "load_number", pick: (f) => f.loadNumber },
  { name: "truck_unit", conf: "truck_unit", pick: (f) => f.truckUnit },
  { name: "total_cents", conf: "total_cents", pick: (f) => f.totalCents },
  { name: "gallons_milli", conf: "gallons_milli", pick: (f) => f.gallonsMilli },
  { name: "price_cents", conf: "price_cents", pick: (f) => f.priceCents },
  { name: "loaded_miles", conf: "loaded_miles", pick: (f) => f.loadedMiles },
  { name: "rate_per_mile_cents", conf: "rate_per_mile_cents", pick: (f) => f.ratePerMileCents },
  { name: "linehaul_cents", conf: "linehaul_cents", pick: (f) => f.linehaulCents },
  { name: "fuel_surcharge_cents", conf: "fuel_surcharge_cents", pick: (f) => f.fuelSurchargeCents },
];

// What the document says, field by field, for a reading that matched no record. Fields the
// document does not print are left out; stop times follow the other fields.
export function claimRows(read: DocumentRead): ClaimRow[] {
  const rows: ClaimRow[] = [];
  for (const c of CLAIM_ORDER) {
    const value = c.pick(read.fields);
    if (value === null) continue;
    rows.push({ key: c.name, name: c.name, value: fieldValue(c.name, value), low: read.confidence[c.conf] === "low" });
  }
  read.fields.stops.forEach((stop, i) => {
    for (const at of ["arrived", "departed"] as const) {
      const value = stop[at];
      if (value === null) continue;
      const name = `${stop.role}_${at}`;
      rows.push({ key: `${name}-${i}`, name, value, low: read.confidence.stops === "low" });
    }
  });
  return rows;
}
