import { describe, expect, it } from "vitest";
import { centsToDecimalString, decimalToCents, dollars } from "./format";

describe("cents and decimal strings", () => {
  it("round-trips 0, 5, 99, 100 and 123456789 cents", () => {
    const cases: [number, string][] = [
      [0, "0.00"],
      [5, "0.05"],
      [99, "0.99"],
      [100, "1.00"],
      [123456789, "1234567.89"],
    ];
    for (const [cents, text] of cases) {
      expect(centsToDecimalString(cents)).toBe(text);
      expect(decimalToCents(text)).toBe(cents);
    }
  });

  it("keeps the sign and reads one decimal place as tens of cents", () => {
    expect(centsToDecimalString(-250)).toBe("-2.50");
    expect(decimalToCents("-2.50")).toBe(-250);
    expect(decimalToCents("12.5")).toBe(1250);
    expect(decimalToCents("12")).toBe(1200);
    expect(decimalToCents("-0")).toBe(0);
    expect(Object.is(decimalToCents("-0.00"), 0)).toBe(true);
  });

  it("refuses anything but a plain decimal with at most two places", () => {
    for (const bad of ["1.234", "1e3", "+1", "1,000", "", " 1", "1 ", "abc", "1.", ".5", "0x10"]) {
      expect(() => decimalToCents(bad), bad).toThrow(RangeError);
    }
    expect(() => decimalToCents(5 as never)).toThrow(RangeError);
    expect(() => decimalToCents("90071992547409.92")).toThrow(RangeError);
  });

  it("refuses cents that are not safe integers", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => centsToDecimalString(bad)).toThrow(RangeError);
      expect(() => dollars(bad)).toThrow(RangeError);
    }
  });
});

describe("dollars", () => {
  it("formats cards with separators and the sign in front", () => {
    expect(dollars(0)).toBe("$0.00");
    expect(dollars(5)).toBe("$0.05");
    expect(dollars(123456)).toBe("$1,234.56");
    expect(dollars(123456789)).toBe("$1,234,567.89");
    expect(dollars(-5)).toBe("-$0.05");
  });
});
