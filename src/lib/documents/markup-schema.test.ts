import { describe, expect, it } from "vitest";
import {
  MARKUP_CHECK_FORMAT,
  MARKUP_CHECK_PROMPT,
  MAX_AMOUNTS_READ,
  MAX_CALLOUT_READ_CHARS,
  parseMarkupCheck,
} from "./markup-schema";
import { DOCUMENT_FORMAT, DOCUMENT_PROMPT } from "./schema";
import { CONFIDENCE_FIELDS } from "./types";

// The read-back is the document schema unchanged plus four keys about what was drawn, parsed as
// strictly as the reading itself.

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document_kind: "lumper_receipt",
    sample_word: true,
    vendor: "Sample Dock Services",
    date_mmddyyyy: "10/26/2026",
    total_cents: 17_500,
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
    text_lines: ["Total $175.00"],
    confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])),
    callout_text: "Not on the paystub yet: $175.00",
    circled_line_text: "Total $175.00",
    circle_count: 1,
    all_amounts_cents: [17_500],
    ...over,
  };
}

const parse = (v: unknown) => parseMarkupCheck(JSON.stringify(v));

describe("MARKUP_CHECK_FORMAT", () => {
  it("is the document schema plus the four drawn keys, all required, and the prompt carries no expected value", () => {
    const base = DOCUMENT_FORMAT.schema as { required: string[]; properties: Record<string, unknown> };
    const schema = MARKUP_CHECK_FORMAT.schema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual([
      ...base.required,
      "callout_text",
      "circled_line_text",
      "circle_count",
      "all_amounts_cents",
    ]);
    for (const k of base.required) expect(schema.properties[k]).toEqual(base.properties[k]);
    expect(MARKUP_CHECK_FORMAT.strict).toBe(true);
    expect(MARKUP_CHECK_PROMPT.startsWith(DOCUMENT_PROMPT)).toBe(true);
    // The added lines name no amount, callout or line: the model reports what it sees.
    expect(MARKUP_CHECK_PROMPT.slice(DOCUMENT_PROMPT.length)).not.toMatch(/\$|\d[.,]\d|paystub|Record says/);
  });
});

describe("parseMarkupCheck", () => {
  it("reads a well-formed answer", () => {
    const read = parse(answer());
    expect(read).toMatchObject({
      calloutText: "Not on the paystub yet: $175.00",
      circledLineText: "Total $175.00",
      circleCount: 1,
      amountsCents: [17_500],
      read: { kind: "lumper_receipt", fields: { totalCents: 17_500, sampleWord: true } },
    });
    expect(read?.raw).toEqual(answer());
    expect(parse(answer({ callout_text: null, circled_line_text: null, circle_count: 0, all_amounts_cents: [] }))).not.toBeNull();
  });

  it.each<[string, unknown]>([
    ["not JSON", "{"],
    ["an array", [answer()]],
    ["a missing drawn key", (() => { const a = answer(); delete a.circle_count; return a; })()],
    ["a callout that is a number", answer({ callout_text: 175 })],
    ["a callout too long", answer({ callout_text: "x".repeat(MAX_CALLOUT_READ_CHARS + 1) })],
    ["a negative circle count", answer({ circle_count: -1 })],
    ["a fractional circle count", answer({ circle_count: 1.5 })],
    ["too many circles", answer({ circle_count: 21 })],
    ["amounts not a list", answer({ all_amounts_cents: 17_500 })],
    ["a fractional amount", answer({ all_amounts_cents: [175.5] })],
    ["too many amounts", answer({ all_amounts_cents: Array.from({ length: MAX_AMOUNTS_READ + 1 }, (_, i) => i) })],
    ["a broken document part", answer({ total_cents: "175.00" })],
    ["an extra key", answer({ note: "hi" })],
  ])("refuses %s", (_name, value) => {
    expect(typeof value === "string" ? parseMarkupCheck(value) : parse(value)).toBeNull();
  });
});
