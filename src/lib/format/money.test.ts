import { describe, expect, it } from "vitest";
import { formatCents, MINUS } from "./money";

describe("formatCents", () => {
  it("writes whole cents as dollars with two decimals and grouped thousands", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(222500)).toBe("$2,225.00");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(Number.MAX_SAFE_INTEGER)).toBe("$90,071,992,547,409.91");
  });

  it("puts a true minus sign (U+2212) before a negative amount", () => {
    expect(formatCents(-20000)).toBe("−$200.00");
    expect(MINUS.codePointAt(0)).toBe(0x2212);
    expect(formatCents(-1)).toBe("−$0.01");
  });

  it("signs positives only when asked, and never signs zero", () => {
    expect(formatCents(240000, { sign: "always" })).toBe("+$2,400.00");
    expect(formatCents(0, { sign: "always" })).toBe("$0.00");
    expect(formatCents(-5500, { sign: "never" })).toBe("$55.00");
    expect(formatCents(-0)).toBe("$0.00");
  });

  it("refuses anything but a safe integer", () => {
    for (const bad of [1.5, Number.NaN, Infinity, 2 ** 53, -(2 ** 53), "100", null, undefined]) {
      expect(() => formatCents(bad as number)).toThrow(RangeError);
    }
  });
});
