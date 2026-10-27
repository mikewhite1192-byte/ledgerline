import { describe, expect, it } from "vitest";
import {
  DOCUMENT_FORMAT,
  MAX_CENTS,
  MAX_TEXT_LINES,
  NO_TEXT_LINE,
  parseRead,
  rawOf,
  READ_VALUES_LINE,
  transcriptionOf,
} from "./schema";
import { CONFIDENCE_FIELDS } from "./types";

// The parser is strict: a reading is exactly the schema's shape within its limits, or nothing.

function allNull(): Record<string, unknown> {
  return {
    document_kind: "other",
    sample_word: false,
    vendor: null,
    date_mmddyyyy: null,
    total_cents: null,
    load_number: null,
    truck_unit: null,
    gallons_milli: null,
    price_cents: null,
    loaded_miles: null,
    rate_per_mile_cents: null,
    linehaul_cents: null,
    fuel_surcharge_cents: null,
    customer_name: null,
    stops: [],
    text_lines: [],
    confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "low"])),
  };
}

function rateCon(): Record<string, unknown> {
  return {
    ...allNull(),
    document_kind: "rate_confirmation",
    sample_word: true,
    load_number: "BR-1042",
    loaded_miles: 612,
    rate_per_mile_cents: 245,
    linehaul_cents: 149_940,
    fuel_surcharge_cents: 18_360,
    customer_name: "Sample Customer Co",
    stops: [{ role: "pickup", arrived: "10/21/2026 7:40 AM EDT", departed: null }],
    text_lines: ["RATE CONFIRMATION", "SAMPLE"],
    confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])),
  };
}

const parse = (v: unknown) => parseRead(JSON.stringify(v));

describe("parseRead", () => {
  it("accepts a reading where every field is null", () => {
    const read = parse(allNull());
    expect(read).not.toBeNull();
    expect(read!.kind).toBe("other");
    expect(read!.fields.totalCents).toBeNull();
    expect(read!.fields.stops).toEqual([]);
  });

  it("reads a full rate confirmation into camelCase fields", () => {
    const read = parse(rateCon())!;
    expect(read.kind).toBe("rate_confirmation");
    expect(read.fields).toMatchObject({
      sampleWord: true,
      loadNumber: "BR-1042",
      loadedMiles: 612,
      ratePerMileCents: 245,
      linehaulCents: 149_940,
      fuelSurchargeCents: 18_360,
    });
    expect(read.confidence.linehaul_cents).toBe("high");
  });

  it("refuses text that is not JSON, or JSON that is not an object", () => {
    expect(parseRead("not json")).toBeNull();
    expect(parseRead("[]")).toBeNull();
    expect(parseRead("null")).toBeNull();
  });

  it("refuses an extra key, a missing key and an unknown kind", () => {
    expect(parse({ ...allNull(), note: "x" })).toBeNull();
    const missing = allNull();
    delete missing.vendor;
    expect(parse(missing)).toBeNull();
    expect(parse({ ...allNull(), document_kind: "invoice" })).toBeNull();
  });

  it("refuses cents as a string, a fraction, a negative or one past the cap", () => {
    expect(parse({ ...allNull(), total_cents: "1234" })).toBeNull();
    expect(parse({ ...allNull(), total_cents: 12.5 })).toBeNull();
    expect(parse({ ...allNull(), total_cents: -1 })).toBeNull();
    expect(parse({ ...allNull(), total_cents: 1e9 })).toBeNull();
    expect(parse({ ...allNull(), total_cents: MAX_CENTS })).not.toBeNull();
  });

  it("refuses too many text lines, a line too long and a line that is not text", () => {
    expect(parse({ ...allNull(), text_lines: Array.from({ length: MAX_TEXT_LINES + 1 }, () => "x") })).toBeNull();
    expect(parse({ ...allNull(), text_lines: Array.from({ length: MAX_TEXT_LINES }, () => "x") })).not.toBeNull();
    expect(parse({ ...allNull(), text_lines: ["x".repeat(161)] })).toBeNull();
    expect(parse({ ...allNull(), text_lines: [1] })).toBeNull();
  });

  it("refuses a bad stop and a confidence off the scale or missing a field", () => {
    expect(parse({ ...allNull(), stops: [{ role: "yard", arrived: null, departed: null }] })).toBeNull();
    expect(parse({ ...allNull(), stops: [{ role: "pickup", arrived: null }] })).toBeNull();
    expect(
      parse({ ...allNull(), stops: Array.from({ length: 5 }, () => ({ role: "pickup", arrived: null, departed: null })) }),
    ).toBeNull();
    const confidence = Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"]));
    expect(parse({ ...allNull(), confidence: { ...confidence, vendor: "sure" } })).toBeNull();
    const short = { ...confidence } as Record<string, string>;
    delete short.stops;
    expect(parse({ ...allNull(), confidence: short })).toBeNull();
  });

  it("round-trips through rawOf, which is what the documents row stores", () => {
    const read = parse(rateCon())!;
    expect(parse(rawOf(read))).toEqual(read);
    expect(rawOf(read)).toEqual(rateCon());
  });
});

describe("DOCUMENT_FORMAT", () => {
  it("is strict and requires every key the parser checks", () => {
    expect(DOCUMENT_FORMAT.strict).toBe(true);
    const schema = DOCUMENT_FORMAT.schema as { required: string[]; additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(allNull()).sort());
  });
});

describe("transcriptionOf", () => {
  it("is the printed lines, then each string value read, labelled, so the screen reads every one", () => {
    const read = parseRead(JSON.stringify({ ...rateCon(), text_lines: ["RATE CONFIRMATION", "LOAD BR-1042"] }))!;
    expect(transcriptionOf(read)).toBe(
      [
        "RATE CONFIRMATION",
        "LOAD BR-1042",
        READ_VALUES_LINE,
        "load number: BR-1042",
        "customer name: Sample Customer Co",
        "stop 1 pickup arrived: 10/21/2026 7:40 AM EDT",
      ].join("\n"),
    );
  });

  it("stands in a line for no printed text, and adds nothing when no string was read", () => {
    const empty = parseRead(JSON.stringify(allNull()))!;
    expect(transcriptionOf(empty)).toBe(NO_TEXT_LINE);
    const blank = parseRead(JSON.stringify({ ...allNull(), text_lines: [" ", ""], vendor: "Sample Vendor" }))!;
    expect(transcriptionOf(blank)).toBe([NO_TEXT_LINE, READ_VALUES_LINE, "vendor: Sample Vendor"].join("\n"));
  });

  it("stays far under the stored text's 200,000 character limit at the schema's largest", () => {
    const longest = parseRead(
      JSON.stringify({
        ...allNull(),
        vendor: "v".repeat(120),
        customer_name: "c".repeat(120),
        date_mmddyyyy: "d".repeat(40),
        load_number: "l".repeat(40),
        truck_unit: "t".repeat(40),
        stops: Array.from({ length: 4 }, () => ({ role: "delivery", arrived: "a".repeat(40), departed: "b".repeat(40) })),
        text_lines: Array.from({ length: MAX_TEXT_LINES }, () => "x".repeat(160)),
      }),
    )!;
    expect(longest).not.toBeNull();
    expect(transcriptionOf(longest).length).toBeLessThan(15_000);
  });
});
