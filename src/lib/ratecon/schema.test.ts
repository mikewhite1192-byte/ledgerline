import { describe, expect, it } from "vitest";
import {
  MAX_ACCESSORIALS,
  MAX_LINE_CHARS,
  MAX_TEXT_LINES,
  NO_TEXT_LINE,
  parseRateCon,
  RATECON_FORMAT,
  rateConTranscriptOf,
  rawOfRateCon,
  READ_VALUES_LINE,
} from "./schema";
import { rateConReading, rateConText } from "./test-fixtures";

// The rate confirmation schema's parser: exactly the schema's shape within its limits, or nothing.

const raw = () => rawOfRateCon(rateConReading());
const text = (v: unknown) => JSON.stringify(v);

describe("parseRateCon", () => {
  it("parses the fixture and gives it back unchanged through the stored shape", () => {
    const r = parseRateCon(rateConText());
    expect(r).toEqual(rateConReading());
    expect(parseRateCon(text(rawOfRateCon(r!)))).toEqual(r);
  });

  it("lists every key the parser demands as required in the strict format", () => {
    expect(RATECON_FORMAT.strict).toBe(true);
    const schema = RATECON_FORMAT.schema as { required: string[]; additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(raw()).sort());
  });

  it("refuses an extra key and a missing key", () => {
    expect(parseRateCon(text({ ...raw(), note: "x" }))).toBeNull();
    const { total_cents: _drop, ...missing } = raw();
    expect(parseRateCon(text(missing))).toBeNull();
  });

  it("refuses an amount given as a string, a fraction or a negative", () => {
    expect(parseRateCon(text({ ...raw(), total_cents: "159500" }))).toBeNull();
    expect(parseRateCon(text({ ...raw(), linehaul_cents: 1350.5 }))).toBeNull();
    expect(parseRateCon(text({ ...raw(), fuel_surcharge_cents: -1 }))).toBeNull();
    expect(parseRateCon(text({ ...raw(), total_cents: 1_000_000_000 }))).toBeNull();
  });

  it("refuses more charge lines than the schema allows, or a kind off its list", () => {
    const line = { kind: "stop", description: null, amount_cents: 100 };
    expect(parseRateCon(text({ ...raw(), accessorials: Array(MAX_ACCESSORIALS).fill(line) }))).not.toBeNull();
    expect(parseRateCon(text({ ...raw(), accessorials: Array(MAX_ACCESSORIALS + 1).fill(line) }))).toBeNull();
    expect(parseRateCon(text({ ...raw(), accessorials: [{ ...line, kind: "toll" }] }))).toBeNull();
    expect(parseRateCon(text({ ...raw(), accessorials: [{ ...line, extra: 1 }] }))).toBeNull();
  });

  it("refuses too many lines, a line too long, a NUL, and a confidence off its list", () => {
    expect(parseRateCon(text({ ...raw(), text_lines: Array(MAX_TEXT_LINES + 1).fill("x") }))).toBeNull();
    expect(parseRateCon(text({ ...raw(), text_lines: ["x".repeat(MAX_LINE_CHARS + 1)] }))).toBeNull();
    expect(parseRateCon(text({ ...raw(), load_number: "RC-1001\u0000" }))).toBeNull();
    expect(parseRateCon(text({ ...raw(), confidence: { ...(raw().confidence as object), total: "sure" } }))).toBeNull();
  });

  it("refuses text that is not one JSON object", () => {
    expect(parseRateCon("not json")).toBeNull();
    expect(parseRateCon("[]")).toBeNull();
    expect(parseRateCon("null")).toBeNull();
  });
});

describe("rateConTranscriptOf", () => {
  it("is the printed lines, then each value the reading claims, one labelled line each", () => {
    const body = rateConTranscriptOf(rateConReading());
    const lines = body.split("\n");
    expect(lines.slice(0, 11)).toEqual(rateConReading().textLines);
    expect(lines.slice(11)).toEqual([
      READ_VALUES_LINE,
      "load number: RC-1001",
      "customer name: Test Shipper",
      "customer code: CUST-1",
      "origin city: Dallas",
      "origin state: TX",
      "destination city: Memphis",
      "destination state: TN",
      "pickup date: 11/05/2026",
      "delivery date: 11/06/2026",
      "driver code: DRV-1",
      "charge 1 stop: Extra stop",
      "charge 2 lumper: Lumper at receiver",
    ]);
  });

  it("is never empty", () => {
    const blank = rateConReading({
      textLines: [],
      loadNumber: null,
      customerName: null,
      customerCode: null,
      originCity: null,
      originState: null,
      destCity: null,
      destState: null,
      pickupDate: null,
      deliveryDate: null,
      driverCode: null,
      accessorials: [],
    });
    expect(rateConTranscriptOf(blank)).toBe(NO_TEXT_LINE);
  });
});
