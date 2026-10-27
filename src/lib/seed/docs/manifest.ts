import raw from "./manifest.json";

// The sample documents under public/samples/docs/ and the seeded row each belongs to. The
// manifest is the answer key: every value a document shows is here, and manifest.test.ts proves
// each one against the seed plan at the manifest's anchor. Nothing here reads a file or calls a
// model; scripts/render-sample-docs.ts and scripts/generate-sample-photos.ts write the files and
// rewrite their entries.

// The only vendor names a receipt may carry: invented, generic, and in one list.
export const SYNTHETIC_VENDORS = ["Dock Services", "Sample Turnpike Authority", "Roadside Fuel Stop"] as const;
export type SyntheticVendor = (typeof SYNTHETIC_VENDORS)[number];

// Written into every photo's EXIF ImageDescription.
export const PHOTO_SAMPLE_SENTENCE =
  "SAMPLE: synthetic document generated for a software demonstration. Invented company names. " +
  "Not a real receipt.";
// Written into the blank background's EXIF ImageDescription.
export const BACKGROUND_SAMPLE_SENTENCE =
  "SAMPLE: blank paper background generated for a software demonstration.";
// The footer on every PDF page and the PDF's Subject.
export const PDF_FOOTER =
  "Fictitious carrier created for a software demonstration. Not a real company or document.";

export const PHOTO_MAX_BYTES = 400 * 1024;
export const PDF_MAX_BYTES = 60 * 1024;
export const SET_MAX_BYTES = 3 * 1024 * 1024;
// Every photo is the model's 1344 x 1792 frame at 75%.
export const PHOTO_WIDTH = 1008;
export const PHOTO_HEIGHT = 1344;

export type ReceiptKind = "lumper_receipt" | "toll_receipt" | "fuel_receipt";
export type PdfKind = "rate_confirmation" | "bill_of_lading";
export type DocKind = ReceiptKind | PdfKind;

export type TenantSlug = "blue-ridge" | "prairie-wind";
export type RefTable = "load_accessorials" | "pay_items" | "fuel_purchases" | "loads";

// The seeded row: its table and id, the human reference DOC-VISION matches on (the load number,
// item ref or purchase ref), and the load it sits on, if any.
export type DocRef = { table: RefTable; id: string; humanRef: string; loadNumber: string | null };

export type Place = { city: string; state: string };
export type Party = Place & { name: string };

// Receipts. date is the tenant-local day (YYYY-MM-DD). Fields the receipt does not print are
// null, so a read that finds one anyway does not match.
export type ReceiptExpect = {
  vendor: SyntheticVendor;
  date: string;
  amountCents: number;
  loadNumber: string | null;
  truckUnit: string;
  gallonsMilli: number | null;
  priceCents: number | null;
  // Lumper receipts.
  paidByDriver?: true;
  // Fuel purchases: the instant, the local time of day, the state, and how it was paid.
  purchasedAt?: string;
  localTime?: string;
  state?: string;
  paidWith?: "company_card";
};

export type LoadExpect = {
  // The delivery day.
  date: string;
  loadNumber: string;
  customer: Party;
  carrier: string;
  origin: Place;
  destination: Place;
  pickupOn: string;
  deliveredOn: string;
  truckUnit: string;
  driverCode: string;
};

export type RateConExpect = LoadExpect & {
  loadedMiles: number;
  ratePerMileCents: number;
  linehaulCents: number;
  fuelSurchargeCents: number;
  totalCents: number;
};

export type StopTimes = {
  pickupArrivedAt: string;
  pickupDepartedAt: string;
  deliveryArrivedAt: string;
  deliveryDepartedAt: string;
};

export type BolExpect = LoadExpect & {
  // The four instants, and each as the carrier's local date and time with its zone.
  stops: StopTimes;
  stopsLocal: StopTimes;
};

// Strings a document prints that no row holds: ours, fixed here, and nothing else.
export type ReceiptShows = { plaza?: string; city?: string };
export type BolShows = { commodity: string; pallets: number };

type FileFields = {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
  tenant: TenantSlug;
  ref: DocRef;
};

export type PhotoDoc = FileFields & {
  kind: ReceiptKind;
  mime: "image/webp";
  width: number;
  height: number;
  // A wide shot in a truck cab, the receipt small and skewed: an input for cropping.
  cabAngle: boolean;
  origin: "generated" | "composed";
  expect: ReceiptExpect;
  shows: ReceiptShows;
};

export type RateConDoc = FileFields & {
  kind: "rate_confirmation";
  mime: "application/pdf";
  pages: number;
  origin: "rendered";
  expect: RateConExpect;
};

export type BolDoc = FileFields & {
  kind: "bill_of_lading";
  mime: "application/pdf";
  pages: number;
  origin: "rendered";
  expect: BolExpect;
  shows: BolShows;
};

export type PdfDoc = RateConDoc | BolDoc;
export type SampleDoc = PhotoDoc | PdfDoc;

export type Background = {
  file: string;
  mime: "image/webp";
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  origin: "generated";
};

export type Manifest = {
  anchor: string;
  // The blank paper the composed fallback is drawn on, or null before it is generated.
  background: Background | null;
  entries: SampleDoc[];
};

const KINDS: readonly DocKind[] = [
  "lumper_receipt",
  "toll_receipt",
  "fuel_receipt",
  "rate_confirmation",
  "bill_of_lading",
];

export function isPhoto(doc: SampleDoc): doc is PhotoDoc {
  return doc.mime === "image/webp";
}

export function isPdf(doc: SampleDoc): doc is PdfDoc {
  return doc.mime === "application/pdf";
}

// A light shape check, so a hand edit that breaks the file fails loudly here instead of
// somewhere downstream. manifest.test.ts checks every value against the seed.
export function parseManifest(value: unknown): Manifest {
  const m = value as Manifest;
  if (
    typeof m !== "object" ||
    m === null ||
    typeof m.anchor !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(m.anchor) ||
    !Array.isArray(m.entries)
  ) {
    throw new Error("sample docs manifest: not a manifest");
  }
  for (const e of m.entries) {
    const photo = e.mime === "image/webp";
    const pdf = e.mime === "application/pdf";
    if (
      typeof e.id !== "string" ||
      !/^[a-z0-9-]+$/.test(e.id) ||
      !KINDS.includes(e.kind) ||
      (!photo && !pdf) ||
      photo !== ["lumper_receipt", "toll_receipt", "fuel_receipt"].includes(e.kind) ||
      e.file !== `samples/docs/${e.id}.${photo ? "webp" : "pdf"}` ||
      typeof e.ref !== "object" ||
      e.ref === null ||
      typeof e.expect !== "object" ||
      e.expect === null
    ) {
      throw new Error(`sample docs manifest: entry ${String(e?.id)} is malformed`);
    }
  }
  const bg = m.background;
  if (
    bg !== null &&
    (typeof bg !== "object" ||
      !/^samples\/docs\/bg\/[a-z0-9-]+\.webp$/.test(String(bg.file)) ||
      bg.mime !== "image/webp")
  ) {
    throw new Error("sample docs manifest: the background is malformed");
  }
  return m;
}

export const MANIFEST: Manifest = parseManifest(raw);
export const SAMPLE_DOCS: readonly SampleDoc[] = MANIFEST.entries;

// The document for one seeded row, by its table and id.
export function sampleDocFor(ref: { table: RefTable; id: string }): SampleDoc | undefined {
  return SAMPLE_DOCS.find((d) => d.ref.table === ref.table && d.ref.id === ref.id);
}
