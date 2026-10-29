import { describe, expect, it } from "vitest";
import { checkMarkup, originalAmounts, type MarkupExpected } from "./markup-check";
import type { MarkupCheckRead } from "./markup-schema";
import { CONFIDENCE_FIELDS, type DocumentRead, type ReadFields } from "./types";

// A marked copy is kept only when its read-back says every document field is unchanged, the
// SAMPLE band is there, the box holds exactly our callout, one oval is around exactly our line,
// and no amount appears that the document or the callout does not hold. Whole values only.

const FIELDS: ReadFields = {
  sampleWord: true,
  vendor: "Sample Dock Services",
  date: "10/26/2026",
  totalCents: 17_500,
  loadNumber: "BR-L10262",
  truckUnit: null,
  gallonsMilli: null,
  priceCents: null,
  loadedMiles: null,
  ratePerMileCents: null,
  linehaulCents: null,
  fuelSurchargeCents: null,
  customerName: null,
  stops: [{ role: "delivery", arrived: "10/26/2026 6:10 AM EDT", departed: null }],
};

const ORIGINAL: DocumentRead = {
  kind: "lumper_receipt",
  fields: FIELDS,
  textLines: ["SAMPLE LUMPER RECEIPT", "Unload fee 2 x $87.50", "Total   $175.00"],
  confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])) as DocumentRead["confidence"],
};

const EXPECTED: MarkupExpected = {
  original: ORIGINAL,
  callout: "Not on the paystub yet: $175.00",
  anchor: "Total   $175.00",
  claimCents: 17_500,
};

function answer(over: Partial<MarkupCheckRead> = {}, fields: Partial<ReadFields> = {}): MarkupCheckRead {
  return {
    read: { ...ORIGINAL, fields: { ...FIELDS, ...fields }, textLines: ["something else"] },
    calloutText: "Not on the paystub yet: $175.00",
    circledLineText: "Total $175.00",
    circleCount: 1,
    amountsCents: [8_750, 17_500],
    raw: {},
    ...over,
  };
}

describe("checkMarkup", () => {
  it("keeps a copy that reads back the same, spacing, case and a closing period aside", () => {
    expect(checkMarkup(EXPECTED, answer())).toEqual({ ok: true });
    expect(
      checkMarkup(
        EXPECTED,
        answer({ calloutText: "not on the paystub\nyet:  $175.00.", circledLineText: "TOTAL $175.00." }, { vendor: " sample dock  SERVICES " }),
      ),
    ).toEqual({ ok: true });
  });

  it("keeps a Spanish callout read back without its accents, and refuses one with another word", () => {
    const spanish: MarkupExpected = { ...EXPECTED, callout: "Aún no está en el talón de pago: $175.00" };
    expect(checkMarkup(spanish, answer({ calloutText: "Aun no esta en el talon de pago: $175.00" }))).toEqual({ ok: true });
    expect(checkMarkup(spanish, answer({ calloutText: "Aún no está en el talón de pago: $175.00" }))).toEqual({ ok: true });
    expect(checkMarkup(spanish, answer({ calloutText: "Aun no esta en el recibo de pago: $175.00" }))).toEqual({
      ok: false,
      category: "callout_wrong",
    });
    expect(checkMarkup(spanish, answer({ calloutText: "Aun no esta en el talon de pago: $157.00" }))).toEqual({
      ok: false,
      category: "callout_wrong",
    });
  });

  it.each<[string, MarkupCheckRead | null, string]>([
    ["no read-back", null, "off_schema"],
    ["a changed total", answer({}, { totalCents: 17_600 }), "field_changed"],
    ["a field read where the original read nothing", answer({}, { truckUnit: "4471" }), "field_changed"],
    ["a different kind", answer({ read: { ...ORIGINAL, kind: "toll_receipt" } }), "field_changed"],
    ["a changed stop time", answer({}, { stops: [{ role: "delivery", arrived: "10/26/2026 7:10 AM EDT", departed: null }] }), "field_changed"],
    ["a dropped stop", answer({}, { stops: [] }), "field_changed"],
    ["the SAMPLE band gone", answer({}, { sampleWord: false }), "field_changed"],
    ["no callout", answer({ calloutText: null }), "callout_wrong"],
    ["a blank callout", answer({ calloutText: " . " }), "callout_wrong"],
    ["a callout with another amount", answer({ calloutText: "Not on the paystub yet: $157.00" }), "callout_wrong"],
    ["a callout that only contains ours", answer({ calloutText: "Note: Not on the paystub yet: $175.00" }), "callout_wrong"],
    ["no oval", answer({ circledLineText: null, circleCount: 0 }), "anchor_wrong"],
    ["two ovals", answer({ circleCount: 2 }), "anchor_wrong"],
    ["the wrong line circled", answer({ circledLineText: "Unload fee 2 x $87.50" }), "anchor_wrong"],
    ["part of our line circled", answer({ circledLineText: "$175.00" }), "anchor_wrong"],
    ["an amount nobody wrote", answer({ amountsCents: [8_750, 17_500, 1_750] }), "extra_amount"],
    ["the claim missing from the amounts", answer({ amountsCents: [8_750] }), "extra_amount"],
  ])("refuses %s", (_name, read, category) => {
    expect(checkMarkup(EXPECTED, read)).toEqual({ ok: false, category });
  });

  it("requires every callout amount, and allows each one", () => {
    const rate: MarkupExpected = {
      original: { ...ORIGINAL, fields: { ...FIELDS, totalCents: null }, textLines: ["Linehaul $1,499.40"] },
      callout: "Load has no rate yet. This page sets $1,499.40 plus $183.60 fuel.",
      anchor: "Linehaul $1,499.40",
      claimCents: 149_940,
    };
    const base = answer(
      { calloutText: rate.callout, circledLineText: rate.anchor, amountsCents: [149_940, 18_360] },
      { totalCents: null },
    );
    expect(checkMarkup(rate, base)).toEqual({ ok: true });
    expect(checkMarkup(rate, { ...base, amountsCents: [149_940] })).toEqual({ ok: false, category: "extra_amount" });
  });
});

describe("originalAmounts", () => {
  it("holds the amount fields and every amount on the transcribed lines", () => {
    expect([...originalAmounts(ORIGINAL)].sort((a, b) => a - b)).toEqual([8_750, 17_500]);
  });
});
