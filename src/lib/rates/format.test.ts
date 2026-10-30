import { describe, expect, it } from "vitest";
import { parseRate, perGallonText } from "./format";

describe("rate words", () => {
  it("writes a diesel price with at least three decimals and a fuel tax rate with four", () => {
    expect(perGallonText("diesel_index", 365_700)).toBe("$3.657");
    expect(perGallonText("diesel_index", 365_750)).toBe("$3.6575");
    expect(perGallonText("diesel_index", 400_000)).toBe("$4.000");
    expect(perGallonText("ifta_rate", 28_500)).toBe("$0.2850");
    expect(perGallonText("ifta_rate", 28_512)).toBe("$0.28512");
    expect(() => perGallonText("diesel_index", -1)).toThrow(RangeError);
    expect(() => perGallonText("diesel_index", 1.5)).toThrow(RangeError);
  });

  it("reads a typed rate in dollars as thousandths of a cent, or null", () => {
    expect(parseRate("3.657")).toBe(365_700);
    expect(parseRate(" 0.285 ")).toBe(28_500);
    expect(parseRate("4")).toBe(400_000);
    expect(parseRate("0.2851")).toBe(28_510);
    for (const bad of ["", "$3.65", "3.65712", "-1", "3,657", "1e2", "123.4", null, 3.657]) {
      expect(parseRate(bad), String(bad)).toBeNull();
    }
  });
});
