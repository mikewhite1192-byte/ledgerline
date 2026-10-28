import { describe, expect, it } from "vitest";
import { TABLES } from "@/lib/rules-engine/types";
import { RECORD_TABLES, hrefOrNull, recordHref } from "./href";

describe("recordHref", () => {
  it("links a record in a known table", () => {
    expect(recordHref({ table: "loads", id: "a1b2" })).toBe("/records/loads/a1b2");
  });

  it("knows every table the rules engine cites", () => {
    expect(RECORD_TABLES).toEqual(TABLES);
    expect(recordHref({ table: "customer_payments", id: "CP-1" })).toBe("/records/customer_payments/CP-1");
  });

  it("sends a pinned rate to the Fuel and tax rates page, which holds every pin", () => {
    expect(recordHref({ table: "pinned_rates", id: "0b6f3c1e-4a2d-4e8b-9c7a-1d2e3f4a5b6c" })).toBe("/settings/rates");
  });

  it("encodes the id so it stays one path segment", () => {
    expect(recordHref({ table: "advances", id: "x/../y" })).toBe("/records/advances/x%2F..%2Fy");
  });

  it("refuses an unknown table or an empty id", () => {
    expect(() => recordHref({ table: "users", id: "1" })).toThrow(RangeError);
    expect(() => recordHref({ table: "loads", id: "" })).toThrow(RangeError);
  });
});

describe("hrefOrNull", () => {
  it("passes a good link through", () => {
    expect(hrefOrNull(recordHref, { table: "loads", id: "L-1" })).toBe("/records/loads/L-1");
  });

  it("turns a refused ref into null", () => {
    expect(hrefOrNull(recordHref, { table: "users", id: "1" })).toBeNull();
    expect(hrefOrNull(recordHref, { table: "loads", id: "" })).toBeNull();
  });

  it("still throws anything that is not a refusal", () => {
    const broken = () => {
      throw new TypeError("broken");
    };
    expect(() => hrefOrNull(broken, { table: "loads", id: "L-1" })).toThrow(TypeError);
  });
});
