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
