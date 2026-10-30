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

// The kinds a stored row may hold: the six a receipt read answers, plus a carrier's pay policy,
// which only the policy upload stores (src/lib/policy-onboard) and the receipt read never answers.
export const STORED_DOCUMENT_KINDS = [...DOCUMENT_KINDS, "pay_policy"] as const;
export type StoredDocumentKind = (typeof STORED_DOCUMENT_KINDS)[number];

export const DOCUMENT_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type DocumentMime = (typeof DOCUMENT_MIMES)[number];

export type ReadStatus = "pending" | "read" | "unreadable" | "budget";

// Model reads one document may start: the upload's own, then Read again twice (0013 checks it).
export const READ_ATTEMPTS_MAX = 3;

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

// A marked copy's state (migration 0055). none: never tried. marking: a try is running.
// checked: kept, the only state with a file. mismatch: the copy did not read back the same
// numbers and was not kept. unavailable: no copy this time (budget, a timeout, an error).
export type MarkupStatus = "none" | "marking" | "checked" | "mismatch" | "unavailable";

// Why a try kept no copy: a fixed word, never upstream text.
export const MARKUP_CATEGORIES = [
  "field_changed",
  "callout_wrong",
  "anchor_wrong",
  "extra_amount",
  "off_schema",
  "no_anchor_line",
  "too_large",
  "timeout",
  "budget",
  "unknown",
] as const;
export type MarkupCategory = (typeof MARKUP_CATEGORIES)[number];

// Tries a document gets in all; a budget refusal before any paid call gives its try back.
export const MARKUP_ATTEMPTS_MAX = 3;

// Whether a marked copy can be asked for, from the reading and its comparison: "eligible", or
// why not (markup-text.ts MarkupBlocked).
export type MarkupEligibility =
  | "eligible"
  | "not_image"
  | "not_read"
  | "not_matched"
  | "agrees"
  | "no_anchor_line";

export type MarkupView = {
  status: MarkupStatus;
  // Tries left, 0 to MARKUP_ATTEMPTS_MAX.
  attemptsLeft: number;
  category: MarkupCategory | null;
  // When the last try started (the checked copy's date), or null.
  at: string | null;
  // A try marked running for longer than the cutoff: its request is gone, so another may start.
  stalled: boolean;
  // Null on a list row, which carries no transcription to plan from.
  eligibility: MarkupEligibility | null;
};

// A photo's crop to the paper (migration 0067). none: never tried (a PDF, or the switch was off).
// cropping: a try is running. cropped: kept; the only state with a file, and the image every read
// after it uses. skipped: a definite no (nothing found, unsure, or our own processing could not
// use the answer); final. unavailable: no answer this time (a timeout, budget, an error); Read
// again may try once more.
export type CropStatus = "none" | "cropping" | "cropped" | "skipped" | "unavailable";

// Why a try kept no crop: a fixed word, never upstream text. The first eight end skipped, the
// rest unavailable.
export const CROP_SKIPPED_CATEGORIES = [
  "no_match",
  "low_confidence",
  "too_small",
  "already_flat",
  "size_mismatch",
  "too_large",
  "bad_image",
  "decode_error",
] as const;
export const CROP_UNAVAILABLE_CATEGORIES = [
  "timeout",
  "unavailable",
  "network",
  "rate_limited",
  "unknown",
  "budget",
  "no_library",
  "stalled",
] as const;
export const CROP_CATEGORIES = [...CROP_SKIPPED_CATEGORIES, ...CROP_UNAVAILABLE_CATEGORIES] as const;
export type CropSkippedCategory = (typeof CROP_SKIPPED_CATEGORIES)[number];
export type CropUnavailableCategory = (typeof CROP_UNAVAILABLE_CATEGORIES)[number];
export type CropCategory = (typeof CROP_CATEGORIES)[number];

// Tries a photo gets in all: the upload's, then one more from Read again after unavailable.
export const CROP_ATTEMPTS_MAX = 2;

// quad: the mask's four corners warped flat. box: the box cut out with a small margin.
export type CropMethod = "quad" | "box";

// Pixels of the normalized frame the segmenter saw (EXIF orientation applied, longest side at
// most 2,000), which width and height give, so a later page can scale them to any display.
export type CropPoint = { x: number; y: number };
export type CropBox = { x1: number; y1: number; x2: number; y2: number; width: number; height: number };

export type CropView = {
  status: CropStatus;
  method: CropMethod | null;
  category: CropCategory | null;
  // The chosen match's confidence in thousandths, or null (none sent, or no match).
  confidence: number | null;
  // The four source corners, top left, top right, bottom right, bottom left; null on a box crop.
  quad: CropPoint[] | null;
  box: CropBox | null;
  // When the last try started, or null.
  at: string | null;
};

// A document as the pages and the routes show it. Never the bytes, never the uploader.
export type DocumentView = {
  id: string;
  filename: string;
  mime: DocumentMime;
  byteLength: number;
  pageCount: number;
  readStatus: ReadStatus;
  kind: StoredDocumentKind | null;
  read: DocumentRead | null;
  match: MatchResult | null;
  inputId: string | null;
  readCallId: string | null;
  traceId: string;
  createdAt: string;
  // A pending read older than two minutes: the request that started it is gone, or its last
  // try could not finish.
  stalled: boolean;
  // Model reads started so far, 1 to READ_ATTEMPTS_MAX.
  readAttempts: number;
  // The marked copy (never its bytes).
  markup: MarkupView;
  // The crop to the paper (never its bytes).
  crop: CropView;
};
