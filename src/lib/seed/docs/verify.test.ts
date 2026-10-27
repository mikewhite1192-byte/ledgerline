import { describe, expect, it } from "vitest";
import { SAMPLE_DOCS, type PhotoDoc } from "./manifest";
import { VERIFY_FORMAT, VERIFY_PROMPT, mismatches, parseRead, type ReceiptRead } from "./verify";

const fuel = SAMPLE_DOCS.find((d) => d.id === "br-fuel-374") as PhotoDoc;
const lumper = SAMPLE_DOCS.find((d) => d.id === "br-l10262-lumper") as PhotoDoc;

const FUEL_READ: ReceiptRead = {
  sample_word: true,
  vendor: "Roadside Fuel Stop",
  date_mmddyyyy: "10/27/2026",
  total_cents: 28640,
  load_number: null,
  truck_unit: "BR-T105",
  gallons_milli: 71600,
  price_cents: 400,
  other_amounts: [400],
};

const LUMPER_READ: ReceiptRead = {
  sample_word: true,
  vendor: "DOCK  SERVICES ",
  date_mmddyyyy: "10/27/2026",
  total_cents: 17500,
  load_number: "br-l10262",
  truck_unit: "BR-T124",
  gallons_milli: null,
  price_cents: null,
  other_amounts: [],
};

describe("the receipt gate", () => {
  it("passes a read that matches on every field", () => {
    expect(mismatches(fuel, FUEL_READ)).toEqual([]);
    // Case and repeated spaces do not matter; characters do.
    expect(mismatches(lumper, LUMPER_READ)).toEqual([]);
  });

  it("rejects a one-cent difference, another date format, a missing SAMPLE and a stray amount", () => {
    expect(mismatches(fuel, { ...FUEL_READ, total_cents: 28641 })).toEqual(["total_cents"]);
    expect(mismatches(fuel, { ...FUEL_READ, date_mmddyyyy: "2026-10-27" })).toEqual([
      "date_mmddyyyy",
    ]);
    expect(mismatches(fuel, { ...FUEL_READ, date_mmddyyyy: "10/27/26" })).toEqual([
      "date_mmddyyyy",
    ]);
    expect(mismatches(fuel, { ...FUEL_READ, sample_word: false })).toEqual(["sample_word"]);
    expect(mismatches(fuel, { ...FUEL_READ, other_amounts: [400, 2864] })).toEqual([
      "other_amounts",
    ]);
    expect(mismatches(fuel, { ...FUEL_READ, gallons_milli: 71000 })).toEqual(["gallons_milli"]);
    expect(mismatches(fuel, { ...FUEL_READ, price_cents: null })).toEqual(["price_cents"]);
    expect(mismatches(fuel, { ...FUEL_READ, truck_unit: "BR-T10" })).toEqual(["truck_unit"]);
    expect(mismatches(fuel, { ...FUEL_READ, truck_unit: "BR-T1050" })).toEqual(["truck_unit"]);
    expect(mismatches(fuel, { ...FUEL_READ, vendor: "Roadside Fuel" })).toEqual(["vendor"]);
    // A load number the receipt does not print is a mismatch too.
    expect(mismatches(fuel, { ...FUEL_READ, load_number: "BR-L10267" })).toEqual(["load_number"]);
    expect(mismatches(lumper, { ...LUMPER_READ, load_number: null })).toEqual(["load_number"]);
  });

  it("parses only an answer of exactly the schema's shape", () => {
    expect(parseRead(JSON.stringify(FUEL_READ))).toEqual(FUEL_READ);
    expect(parseRead("not json")).toBeNull();
    expect(parseRead("[]")).toBeNull();
    expect(parseRead("null")).toBeNull();
    expect(parseRead(JSON.stringify({ ...FUEL_READ, extra: 1 }))).toBeNull();
    const missing: Partial<typeof FUEL_READ> = { ...FUEL_READ };
    delete missing.vendor;
    expect(parseRead(JSON.stringify(missing))).toBeNull();
    expect(parseRead(JSON.stringify({ ...FUEL_READ, total_cents: "28640" }))).toBeNull();
    expect(parseRead(JSON.stringify({ ...FUEL_READ, total_cents: 286.4 }))).toBeNull();
    expect(parseRead(JSON.stringify({ ...FUEL_READ, sample_word: "true" }))).toBeNull();
    expect(parseRead(JSON.stringify({ ...FUEL_READ, other_amounts: [1.5] }))).toBeNull();
    expect(parseRead(JSON.stringify({ ...FUEL_READ, gallons_milli: "71600" }))).toBeNull();
  });

  it("asks for every field the schema requires, and gives away no expected value", () => {
    const schema = VERIFY_FORMAT.schema as { required: string[]; additionalProperties: boolean };
    expect(VERIFY_FORMAT.strict).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    for (const key of schema.required) expect(VERIFY_PROMPT).toContain(`${key}:`);
    for (const d of SAMPLE_DOCS) {
      for (const v of Object.values(d.expect)) {
        if (typeof v === "string" && v.length > 3) expect(VERIFY_PROMPT).not.toContain(v);
      }
    }
  });
});
