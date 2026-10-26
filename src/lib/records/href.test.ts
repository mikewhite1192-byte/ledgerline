import { describe, expect, it } from "vitest";
import { recordHref } from "./href";

describe("recordHref", () => {
  it("links a record in a known table", () => {
    expect(recordHref({ table: "loads", id: "a1b2" })).toBe("/records/loads/a1b2");
  });

  it("encodes the id so it stays one path segment", () => {
    expect(recordHref({ table: "advances", id: "x/../y" })).toBe("/records/advances/x%2F..%2Fy");
  });

  it("refuses an unknown table or an empty id", () => {
    expect(() => recordHref({ table: "users", id: "1" })).toThrow(RangeError);
    expect(() => recordHref({ table: "loads", id: "" })).toThrow(RangeError);
  });
});
