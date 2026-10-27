import type { AiFormat } from "../../ai";
import { mmddyyyy } from "./documents";
import type { PhotoDoc } from "./manifest";

// The gate a generated receipt passes before it is kept: a vision read under a strict schema,
// compared with the manifest by whole value on every field. The prompt holds no expected value,
// so the read cannot echo the answer key. Anything off schema is a failure, never a pass.

export type ReceiptRead = {
  sample_word: boolean;
  vendor: string;
  date_mmddyyyy: string;
  total_cents: number;
  load_number: string | null;
  truck_unit: string | null;
  gallons_milli: number | null;
  price_cents: number | null;
  other_amounts: number[];
};

const KEYS: readonly (keyof ReceiptRead)[] = [
  "sample_word",
  "vendor",
  "date_mmddyyyy",
  "total_cents",
  "load_number",
  "truck_unit",
  "gallons_milli",
  "price_cents",
  "other_amounts",
];

export const VERIFY_FORMAT: AiFormat = {
  name: "receipt_read",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [...KEYS],
    properties: {
      sample_word: { type: "boolean" },
      vendor: { type: "string" },
      date_mmddyyyy: { type: "string" },
      total_cents: { type: "integer" },
      load_number: { type: ["string", "null"] },
      truck_unit: { type: ["string", "null"] },
      gallons_milli: { type: ["integer", "null"] },
      price_cents: { type: ["integer", "null"] },
      other_amounts: { type: "array", items: { type: "integer" } },
    },
  },
};

export const VERIFY_PROMPT = [
  "Read the printed paper receipt in this photo and report only what is printed on it. Do not",
  "guess, complete or correct anything.",
  "sample_word: true only if the word SAMPLE is printed on the receipt.",
  "vendor: the business name exactly as printed.",
  "date_mmddyyyy: the date as MM/DD/YYYY.",
  "total_cents: the total or toll amount in cents ($12.34 is 1234).",
  "load_number: the load number if one is printed, else null.",
  "truck_unit: the truck number as printed, else null.",
  "gallons_milli: the gallons times 1000 if printed (12.345 gal is 12345), else null.",
  "price_cents: the price per gallon in cents if printed ($3.210 is 321), else null.",
  "other_amounts: every other dollar amount printed besides the total, in cents; empty if none.",
].join("\n");

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isIntOrNull = (v: unknown) => v === null || isInt(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

// The model's text as a ReceiptRead, or null when it is not exactly that shape.
export function parseRead(text: string): ReceiptRead | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort();
  if (keys.length !== KEYS.length || keys.join() !== [...KEYS].sort().join()) return null;
  if (
    typeof v.sample_word !== "boolean" ||
    typeof v.vendor !== "string" ||
    typeof v.date_mmddyyyy !== "string" ||
    !isInt(v.total_cents) ||
    !isStrOrNull(v.load_number) ||
    !isStrOrNull(v.truck_unit) ||
    !isIntOrNull(v.gallons_milli) ||
    !isIntOrNull(v.price_cents) ||
    !Array.isArray(v.other_amounts) ||
    !v.other_amounts.every(isInt)
  ) {
    return null;
  }
  return v as ReceiptRead;
}

// Case and runs of spaces do not matter; every character does.
function norm(s: string | null): string | null {
  return s === null ? null : s.trim().replace(/\s+/g, " ").toUpperCase();
}

// The fields that differ from the manifest, by name only (never the values). Empty means the
// read matches.
export function mismatches(doc: PhotoDoc, read: ReceiptRead): string[] {
  const e = doc.expect;
  const out: string[] = [];
  if (read.sample_word !== true) out.push("sample_word");
  if (norm(read.vendor) !== norm(e.vendor)) out.push("vendor");
  if (read.date_mmddyyyy.trim() !== mmddyyyy(e.date)) out.push("date_mmddyyyy");
  if (read.total_cents !== e.amountCents) out.push("total_cents");
  if (norm(read.load_number) !== norm(e.loadNumber)) out.push("load_number");
  if (norm(read.truck_unit) !== norm(e.truckUnit)) out.push("truck_unit");
  if (read.gallons_milli !== e.gallonsMilli) out.push("gallons_milli");
  if (read.price_cents !== e.priceCents) out.push("price_cents");
  const allowed = new Set([e.amountCents, ...(e.priceCents === null ? [] : [e.priceCents])]);
  if (!read.other_amounts.every((a) => allowed.has(a))) out.push("other_amounts");
  return out;
}
