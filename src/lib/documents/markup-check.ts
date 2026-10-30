import { norm } from "./match";
import { amountsIn } from "./markup-text";
import type { MarkupCheckRead } from "./markup-schema";
import { CONFIDENCE_FIELDS, type ConfidenceField, type DocumentRead, type StopClaim } from "./types";

// Whether a marked copy may be kept: its read-back compared with the original reading and with
// the callout and line our code asked for, by whole values only (strings after trimming,
// collapsing spaces and line breaks and upper-casing, and for the callout and the line also
// closing periods off, and for the callout also accents off; integers exactly; a value the
// original read as null must still be null). Pure. The first failing rule names the category; a
// copy that fails any rule is never stored or shown.
//
//   off_schema     the read-back is not the schema's shape
//   field_changed  a document field reads differently, or the SAMPLE band is gone
//   callout_wrong  the box does not hold exactly our callout
//   anchor_wrong   the oval is not around exactly our line, or there is not exactly one oval
//   extra_amount   an amount appears that neither the document nor the callout holds, or one the
//                  callout or the claim holds is missing

export type MarkupMismatch = "off_schema" | "field_changed" | "callout_wrong" | "anchor_wrong" | "extra_amount";

export type MarkupExpected = {
  original: DocumentRead;
  callout: string;
  anchor: string;
  claimCents: number | null;
};

export type MarkupVerdict = { ok: true } | { ok: false; category: MarkupMismatch };

function fieldValue(read: DocumentRead, f: ConfidenceField): string | number | null | StopClaim[] {
  const v = read.fields;
  switch (f) {
    case "document_kind":
      return read.kind;
    case "vendor":
      return v.vendor;
    case "date_mmddyyyy":
      return v.date;
    case "total_cents":
      return v.totalCents;
    case "load_number":
      return v.loadNumber;
    case "truck_unit":
      return v.truckUnit;
    case "gallons_milli":
      return v.gallonsMilli;
    case "price_cents":
      return v.priceCents;
    case "loaded_miles":
      return v.loadedMiles;
    case "rate_per_mile_cents":
      return v.ratePerMileCents;
    case "linehaul_cents":
      return v.linehaulCents;
    case "fuel_surcharge_cents":
      return v.fuelSurchargeCents;
    case "customer_name":
      return v.customerName;
    case "stops":
      return v.stops;
  }
}

// A drawn sentence as compared: norm, then any closing periods off (a reader may add or drop the
// full stop after the last amount; a period never changes a number). Still the whole text.
function drawn(s: string | null): string | null {
  const n = norm(s);
  if (n === null) return null;
  const out = n.replace(/[.\s]+$/, "");
  return out === "" ? null : out;
}

// The callout as compared: drawn, then accents off on both sides (NFD, combining marks removed),
// because a reader may drop the accent on a Spanish word ("Aun", "mas"); an accent never changes a
// number. Still the whole text.
function calloutKey(s: string | null): string | null {
  const d = drawn(s);
  if (d === null) return null;
  const out = d.normalize("NFD").replace(/\p{M}/gu, "");
  return out === "" ? null : out;
}

function sameScalar(a: string | number | null, b: string | number | null): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" || typeof b === "number") return a === b;
  return norm(a) === norm(b);
}

function sameStops(a: StopClaim[], b: StopClaim[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (s, i) =>
        s.role === b[i].role && sameScalar(s.arrived, b[i].arrived) && sameScalar(s.departed, b[i].departed),
    )
  );
}

function sameField(original: DocumentRead, copy: DocumentRead, f: ConfidenceField): boolean {
  const a = fieldValue(original, f);
  const b = fieldValue(copy, f);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && sameStops(a, b);
  }
  return sameScalar(a, b);
}

// Every amount the original document holds: its amount fields and every amount on its lines.
export function originalAmounts(read: DocumentRead): Set<number> {
  const f = read.fields;
  const out = new Set<number>(amountsIn(read.textLines.join("\n")));
  for (const v of [f.totalCents, f.priceCents, f.ratePerMileCents, f.linehaulCents, f.fuelSurchargeCents]) {
    if (v !== null) out.add(v);
  }
  return out;
}

export function checkMarkup(expected: MarkupExpected, answer: MarkupCheckRead | null): MarkupVerdict {
  if (!answer) return { ok: false, category: "off_schema" };
  const copy = answer.read;
  if (!CONFIDENCE_FIELDS.every((f) => sameField(expected.original, copy, f))) {
    return { ok: false, category: "field_changed" };
  }
  if (!copy.fields.sampleWord) return { ok: false, category: "field_changed" };
  const callout = calloutKey(answer.calloutText);
  if (callout === null || callout !== calloutKey(expected.callout)) {
    return { ok: false, category: "callout_wrong" };
  }
  const circled = drawn(answer.circledLineText);
  if (
    circled === null ||
    circled !== drawn(expected.anchor) ||
    answer.circleCount !== 1
  ) {
    return { ok: false, category: "anchor_wrong" };
  }
  const calloutAmounts = amountsIn(expected.callout);
  const allowed = originalAmounts(expected.original);
  for (const a of calloutAmounts) allowed.add(a);
  const seen = new Set(answer.amountsCents);
  const required = [...calloutAmounts, ...(expected.claimCents === null ? [] : [expected.claimCents])];
  if (![...seen].every((a) => allowed.has(a)) || !required.every((a) => seen.has(a))) {
    return { ok: false, category: "extra_amount" };
  }
  return { ok: true };
}
