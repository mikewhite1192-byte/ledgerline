import { describe, expect, it } from "vitest";
import { centsOf, dollarsOf } from "./rules-form";

describe("the autopilot limits in dollars", () => {
  it("shows whole cents as dollars the owner can type back", () => {
    expect(dollarsOf(30_000)).toBe("$300.00");
    expect(dollarsOf(1_000_005)).toBe("$10,000.05");
    expect(dollarsOf(0)).toBe("$0.00");
    expect(centsOf(dollarsOf(1_000_005))).toBe(1_000_005);
  });

  it("reads typed dollars to whole cents without rounding", () => {
    expect(centsOf("300")).toBe(30_000);
    expect(centsOf(" $1,500.5 ")).toBe(150_050);
    expect(centsOf("0.07")).toBe(7);
  });

  it("refuses anything that is not plain dollars", () => {
    for (const bad of ["", "abc", "1.234", "-5", "1,50", "12,3456.00", "1e3", "$"]) expect(centsOf(bad)).toBeNaN();
  });
});
