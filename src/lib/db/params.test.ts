import { describe, expect, it } from "vitest";
import { toDataApiParams } from "./params";

describe("toDataApiParams", () => {
  it("rewrites $n placeholders to named parameters, two-digit ones included", () => {
    const params = Array.from({ length: 12 }, (_, i) => `v${i + 1}`);
    const sql = "SELECT $1, $12, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $1";
    const out = toDataApiParams(sql, params);
    expect(out.sql).toBe(
      "SELECT :p1, :p12, :p2, :p3, :p4, :p5, :p6, :p7, :p8, :p9, :p10, :p11, :p1",
    );
    expect(out.parameters[11]).toEqual({ name: "p12", value: { stringValue: "v12" } });
  });

  it("maps each value to its typed field", () => {
    const out = toDataApiParams("SELECT $1, $2, $3, $4, $5", ["text", 12_345, -1, true, null]);
    expect(out.parameters).toEqual([
      { name: "p1", value: { stringValue: "text" } },
      { name: "p2", value: { longValue: 12_345 } },
      { name: "p3", value: { longValue: -1 } },
      { name: "p4", value: { booleanValue: true } },
      { name: "p5", value: { isNull: true } },
    ]);
  });

  it("refuses a float or an unsafe integer, so cents never lose precision", () => {
    expect(() => toDataApiParams("SELECT $1", [12.5])).toThrow(/safe integer/);
    expect(() => toDataApiParams("SELECT $1", [2 ** 53])).toThrow(/safe integer/);
    expect(() => toDataApiParams("SELECT $1", [Number.NaN])).toThrow(/safe integer/);
  });

  it("refuses an unsupported type", () => {
    const bad = [{}] as unknown as string[];
    expect(() => toDataApiParams("SELECT $1", bad)).toThrow(/unsupported type/);
  });

  it("refuses a placeholder without a value and a value without a placeholder", () => {
    expect(() => toDataApiParams("SELECT $2", ["a"])).toThrow(/no parameter/);
    expect(() => toDataApiParams("SELECT $0", ["a"])).toThrow(/no parameter/);
    expect(() => toDataApiParams("SELECT $1", ["a", "b"])).toThrow(/every parameter/);
  });
});
