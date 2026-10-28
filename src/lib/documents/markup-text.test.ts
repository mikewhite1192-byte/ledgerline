import { describe, expect, it } from "vitest";
import {
  amountsIn,
  anchorLine,
  calloutValue,
  MARKUP_CALLOUT_MAX,
  markupPrompt,
  planMarkup,
  printedForms,
} from "./markup-text";
import {
  CONFIDENCE_FIELDS,
  type DocumentMime,
  type DocumentRead,
  type FieldCheck,
  type MatchResult,
  type ReadFields,
} from "./types";

// What a marked copy would show is worked out by code alone. These pin the target, the callout's
// words and numbers, and the line the circle goes around, from a stored reading and its match.

const EMPTY: ReadFields = {
  sampleWord: true,
  vendor: null,
  date: null,
  totalCents: null,
  loadNumber: null,
  truckUnit: null,
  gallonsMilli: null,
  priceCents: null,
  loadedMiles: null,
  ratePerMileCents: null,
  linehaulCents: null,
  fuelSurchargeCents: null,
  customerName: null,
  stops: [],
};

function readOf(fields: Partial<ReadFields>, textLines: string[]): DocumentRead {
  const confidence = Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])) as DocumentRead["confidence"];
  return { kind: "lumper_receipt", fields: { ...EMPTY, ...fields }, textLines, confidence };
}

function matchOf(fields: FieldCheck[], supports: "missing_reimbursement" | "load_rate_fill" | null): MatchResult {
  return {
    found: true,
    table: "loads",
    id: "00000000-0000-4000-8000-000000000001",
    humanRef: "BR-L10262",
    loadId: null,
    driverId: null,
    fields,
    notes: [],
    supports,
  };
}

const LUMPER = readOf({ totalCents: 17_500, loadNumber: "BR-L10262" }, [
  "SAMPLE LUMPER RECEIPT",
  "Load BR-L10262",
  "Unload fee  175.00 each",
  "Total   $175.00",
  "SAMPLE",
]);
const doc = (read: DocumentRead | null, match: MatchResult | null, mime: DocumentMime = "image/png") => ({
  mime,
  read,
  match,
});

describe("calloutValue and printedForms", () => {
  it("writes amounts as money, gallons to three places, miles with commas, strings collapsed", () => {
    expect(calloutValue("total_cents", 123_450)).toBe("$1,234.50");
    expect(calloutValue("gallons_milli", 52_418)).toBe("52.418 gal");
    expect(calloutValue("loaded_miles", 1_204)).toBe("1,204 mi");
    expect(calloutValue("load_number", "  BR-1042 \n A ")).toBe("BR-1042 A");
    expect(calloutValue("vendor", "   ")).toBeNull();
    expect(calloutValue("total_cents", null)).toBeNull();
    expect(calloutValue("total_cents", -5)).toBeNull();
    expect(calloutValue("total_cents", 1.5)).toBeNull();
  });

  it("lists every way an amount may be printed", () => {
    expect(printedForms("total_cents", 123_450)).toEqual(["$1,234.50", "1,234.50", "$1234.50", "1234.50"]);
    expect(printedForms("loaded_miles", 1_204)).toEqual(["1,204", "1204"]);
    expect(printedForms("gallons_milli", 52_418)).toEqual(["52.418", "52.418"]);
    expect(printedForms("load_number", "BR-1042")).toEqual(["BR-1042"]);
    expect(printedForms("total_cents", -1)).toEqual([]);
  });
});

describe("anchorLine", () => {
  it("picks the first line holding the value as whole tokens, spacing as read", () => {
    // "175.00 each" holds the plain form too, so it wins by order.
    expect(anchorLine(LUMPER.textLines, "total_cents", 17_500)).toBe("Unload fee  175.00 each");
    expect(anchorLine(["Total   $175.00"], "total_cents", 17_500)).toBe("Total   $175.00");
    expect(anchorLine(["Total: $1,234.50."], "total_cents", 123_450)).toBe("Total: $1,234.50.");
  });

  it("never matches part of a value", () => {
    expect(anchorLine(["Total $1175.00", "Ref 175.001"], "total_cents", 17_500)).toBeNull();
    expect(anchorLine(["Load BR-10421"], "load_number", "BR-1042")).toBeNull();
    expect(anchorLine(["Load BR-1042 delivered"], "load_number", "BR-1042")).toBe("Load BR-1042 delivered");
  });

  it("skips a line too long or with characters the prompt never quotes", () => {
    const long = `Total $175.00 ${"x".repeat(80)}`;
    expect(anchorLine([long], "total_cents", 17_500)).toBeNull();
    expect(anchorLine(["Total $175.00 “paid”"], "total_cents", 17_500)).toBeNull();
    expect(anchorLine(["Total $175.00 <b>"], "total_cents", 17_500)).toBeNull();
  });
});

describe("amountsIn", () => {
  it("reads amounts with cents or a dollar sign, and skips longer numbers whole", () => {
    expect(amountsIn("Total $1,234.50 and 99.00, fee $175")).toEqual([123_450, 9_900, 17_500]);
    expect(amountsIn("52.418 gal at $3.899, unit 4471, 12 stops")).toEqual([]);
    expect(amountsIn("Ref175.00 x1.25")).toEqual([]);
    expect(amountsIn("Aún no está en el talón de pago: $175.00")).toEqual([17_500]);
  });
});

describe("planMarkup", () => {
  it("refuses a PDF, a document never read, and one with no record", () => {
    const match = matchOf([], "missing_reimbursement");
    expect(planMarkup(doc(LUMPER, match, "application/pdf"))).toEqual({ ok: false, reason: "not_image" });
    expect(planMarkup(doc(null, match))).toEqual({ ok: false, reason: "not_read" });
    expect(planMarkup(doc(LUMPER, null))).toEqual({ ok: false, reason: "not_matched" });
    expect(planMarkup(doc(LUMPER, { found: false, reason: "no_record" }))).toEqual({
      ok: false,
      reason: "not_matched",
    });
  });

  it("has nothing to mark when every field agrees and nothing is proposed", () => {
    const match = matchOf([{ name: "total_cents", claim: 17_500, record: 17_500, status: "same" }], null);
    expect(planMarkup(doc(LUMPER, match))).toEqual({ ok: false, reason: "agrees" });
  });

  it("marks a field that differs, with the record's value and the document's", () => {
    const read = readOf({ totalCents: 17_500 }, ["SAMPLE", "Total   $175.00"]);
    const match = matchOf([{ name: "total_cents", claim: 17_500, record: 15_000, status: "differs" }], null);
    expect(planMarkup(doc(read, match))).toEqual({
      ok: true,
      target: "total_cents",
      callout: "Record says $150.00. Document says $175.00.",
      anchor: "Total   $175.00",
      claimCents: 17_500,
      hasSampleBand: true,
    });
    expect(planMarkup(doc(read, match), "es")).toMatchObject({
      callout: "El registro dice $150.00. El documento dice $175.00.",
    });
  });

  it("moves to the next differing field when the first is printed on no line", () => {
    const read = readOf({ totalCents: 17_500, loadNumber: "BR-1042" }, ["Load BR-1042"]);
    const match = matchOf(
      [
        { name: "total_cents", claim: 17_500, record: 15_000, status: "differs" },
        { name: "load_number", claim: "BR-1042", record: "BR-1043", status: "differs" },
      ],
      null,
    );
    expect(planMarkup(doc(read, match))).toMatchObject({
      ok: true,
      target: "load_number",
      anchor: "Load BR-1042",
      claimCents: null,
    });
    const nowhere = readOf({ totalCents: 17_500 }, ["SAMPLE"]);
    expect(planMarkup(doc(nowhere, match))).toEqual({ ok: false, reason: "no_anchor_line" });
  });

  it("marks a missing reimbursement on the total, in Spanish for a Spanish speaker", () => {
    const read = readOf({ totalCents: 17_500 }, ["SAMPLE", "Total   $175.00"]);
    const match = matchOf([{ name: "total_cents", claim: 17_500, record: null, status: "no_record_value" }], "missing_reimbursement");
    expect(planMarkup(doc(read, match), "es")).toEqual({
      ok: true,
      target: "total_cents",
      callout: "Aún no está en el talón de pago: $175.00",
      anchor: "Total   $175.00",
      claimCents: 17_500,
      hasSampleBand: true,
    });
    expect(planMarkup(doc(read, match))).toMatchObject({ callout: "Not on the paystub yet: $175.00" });
  });

  it("marks a rate confirmation's linehaul, else its fuel surcharge, for a load with no rate", () => {
    const read = readOf({ linehaulCents: 149_940, fuelSurchargeCents: 18_360 }, [
      "RATE CONFIRMATION",
      "Fuel surcharge $183.60",
      "Linehaul $1,499.40",
    ]);
    const match = matchOf(
      [
        { name: "linehaul_cents", claim: 149_940, record: null, status: "no_record_value" },
        { name: "fuel_surcharge_cents", claim: 18_360, record: null, status: "no_record_value" },
      ],
      "load_rate_fill",
    );
    expect(planMarkup(doc(read, match))).toMatchObject({
      ok: true,
      target: "linehaul_cents",
      callout: "Load has no rate yet. This page sets $1,499.40 plus $183.60 fuel.",
      anchor: "Linehaul $1,499.40",
      claimCents: 149_940,
    });
    const fscOnly = readOf(read.fields, ["Fuel surcharge $183.60"]);
    expect(planMarkup(doc(fscOnly, match))).toMatchObject({ target: "fuel_surcharge_cents", anchor: "Fuel surcharge $183.60" });
  });

  it("falls back to English when the Spanish callout is too long, and refuses when neither fits", () => {
    // The Spanish rate sentence for these amounts runs past the limit; the English one fits.
    const read = readOf({ linehaulCents: 1_234_567_00, fuelSurchargeCents: 1_234_567_00 }, ["Linehaul $1,234,567.00"]);
    const match = matchOf([], "load_rate_fill");
    const es = planMarkup(doc(read, match), "es");
    expect(es.ok).toBe(true);
    if (es.ok) {
      expect(es.callout.startsWith("Load has no rate yet.")).toBe(true);
      expect(es.callout.length).toBeLessThanOrEqual(MARKUP_CALLOUT_MAX);
    }
    const name = "SAMPLE CUSTOMER LOGISTICS AND WAREHOUSING";
    const long = readOf({ customerName: name }, [name]);
    const differs = matchOf([{ name: "customer_name", claim: name, record: `${name} CO`, status: "differs" }], null);
    expect(planMarkup(doc(long, differs), "es")).toEqual({ ok: false, reason: "no_anchor_line" });
  });

  it("asks the edit to add a SAMPLE band only when the reading saw none", () => {
    const read = readOf({ totalCents: 17_500, sampleWord: false }, ["Total $175.00"]);
    const match = matchOf([], "missing_reimbursement");
    const plan = planMarkup(doc(read, match));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.hasSampleBand).toBe(false);
    expect(markupPrompt(plan)).toBe(
      "On this photo draw one red oval around the printed line that reads exactly: Total $175.00. " +
        "Next to it add one white box with a red border containing exactly this text: Not on the paystub yet: $175.00. " +
        "Keep every other letter, number and part of the photo exactly as it is, and add one dark band along the bottom edge with the word SAMPLE in large white letters.",
    );
    expect(markupPrompt({ ...plan, hasSampleBand: true })).toContain("including the SAMPLE band.");
  });
});
