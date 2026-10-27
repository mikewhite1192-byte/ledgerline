// The shapes of an uploaded document, its reading and its comparison with the records. Types
// only: agent code may import this file (and only this, schema, match and candidates) from here.

export const DOCUMENT_KINDS = [
  "lumper_receipt",
  "toll_receipt",
  "fuel_receipt",
  "rate_confirmation",
  "bill_of_lading",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type DocumentMime = (typeof DOCUMENT_MIMES)[number];

export type ReadStatus = "pending" | "read" | "unreadable" | "budget";

export type FieldConfidence = "low" | "medium" | "high";

export type StopClaim = {
  role: "pickup" | "delivery";
  arrived: string | null;
  departed: string | null;
};

// What the document says, as Muse Spark read it. Every value is a claim, never a fact.
export type ReadFields = {
  sampleWord: boolean;
  vendor: string | null;
  // MM/DD/YYYY as printed.
  date: string | null;
  totalCents: number | null;
  loadNumber: string | null;
  truckUnit: string | null;
  gallonsMilli: number | null;
  priceCents: number | null;
  loadedMiles: number | null;
  ratePerMileCents: number | null;
  linehaulCents: number | null;
  fuelSurchargeCents: number | null;
  customerName: string | null;
  stops: StopClaim[];
};

// The fields a confidence is given for.
export const CONFIDENCE_FIELDS = [
  "document_kind",
  "vendor",
  "date_mmddyyyy",
  "total_cents",
  "load_number",
  "truck_unit",
  "gallons_milli",
  "price_cents",
  "loaded_miles",
  "rate_per_mile_cents",
  "linehaul_cents",
  "fuel_surcharge_cents",
  "customer_name",
  "stops",
] as const;
export type ConfidenceField = (typeof CONFIDENCE_FIELDS)[number];

export type DocumentRead = {
  kind: DocumentKind;
  fields: ReadFields;
  textLines: string[];
  confidence: Record<ConfidenceField, FieldConfidence>;
};

// One compared field. claim and record are display values (whole strings or integers).
//   same             the document and the record carry the same whole value
//   differs          both carry a value and they are not equal
//   no_record_value  the record has nothing there (a load with no rate)
//   low_confidence   the reading marked this field low; it is not compared
//   not_shown        the document does not print this field
export type FieldStatus = "same" | "differs" | "no_record_value" | "low_confidence" | "not_shown";

export type FieldCheck = {
  name: string;
  claim: string | number | null;
  record: string | number | null;
  status: FieldStatus;
};

// Facts code worked out from the comparison. Fixed categories, shown as fixed sentences.
export type MatchNote =
  | "arithmetic_checks"
  | "arithmetic_off"
  | "reimbursement_found"
  | "reimbursement_missing"
  | "record_has_no_rate"
  | "no_detention_recorded"
  | "fuel_reimbursement_matched";

export type MatchedTable = "loads" | "load_accessorials" | "pay_items" | "fuel_purchases";

// What a match supports a person proposing: a missing reimbursement (through the existing pay
// correction) or filling a load's empty rate. Null: nothing; the match is shown, never proposed.
export type MatchSupports = "missing_reimbursement" | "load_rate_fill" | null;

export type MatchFound = {
  found: true;
  table: MatchedTable;
  id: string;
  humanRef: string;
  loadId: string | null;
  driverId: string | null;
  fields: FieldCheck[];
  notes: MatchNote[];
  supports: MatchSupports;
};

export type MatchNone = {
  found: false;
  reason: "no_load" | "no_record" | "low_confidence" | "unreadable" | "ambiguous";
};

export type MatchResult = MatchFound | MatchNone;

// A document as the pages and the routes show it. Never the bytes, never the uploader.
export type DocumentView = {
  id: string;
  filename: string;
  mime: DocumentMime;
  byteLength: number;
  pageCount: number;
  readStatus: ReadStatus;
  kind: DocumentKind | null;
  read: DocumentRead | null;
  match: MatchResult | null;
  inputId: string | null;
  readCallId: string | null;
  traceId: string;
  createdAt: string;
  // A pending read older than two minutes: the request that started it is gone.
  stalled: boolean;
};
