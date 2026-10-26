import { describe, expect, it } from "vitest";
import { assertCents, assertCount, cents, mul, mulBps, roundHalfUp, sub, sum } from "./money";
import { InputError } from "./types";

describe("roundHalfUp", () => {
  it.each([
    [0, 10_000, 0],
    [4_999, 10_000, 0],
    [5_000, 10_000, 1],
    [15_000, 10_000, 2],
    [750_007_500, 10_000, 75_001],
    [93_332_400, 10_000, 9_333],
    // Odd denominators round the same way Math.floor((n + d / 2) / d) would.
    [1, 3, 0],
    [2, 3, 1],
    [1_500, 1_000, 2],
    [1_499, 1_000, 1],
  ])("%i / %i is %i", (n, d, expected) => {
    expect(roundHalfUp(n, d)).toBe(expected);
  });

  it("refuses a negative numerator, a zero denominator and a fraction", () => {
    expect(() => roundHalfUp(-1, 10_000)).toThrow(InputError);
    expect(() => roundHalfUp(1, 0)).toThrow(InputError);
    expect(() => roundHalfUp(1.5, 10)).toThrow(/safe integer/);
    expect(() => roundHalfUp(2 ** 53, 10)).toThrow(/safe integer/);
  });
});

describe("mulBps", () => {
  it.each([
    // 75% of 100,001 is 75,000.75, which rounds up.
    [100_001, 7_500, 75_001],
    // 28% of 33,333 is 9,333.24, which rounds down.
    [33_333, 2_800, 9_333],
    // Half a cent rounds up: 50% of 1 is 1.
    [1, 5_000, 1],
    [110_000, 7_500, 82_500],
    [0, 7_500, 0],
    [123_456, 0, 0],
    [123_456, 10_000, 123_456],
    // The largest product the tables allow: 10^9 cents x 10^4 bps.
    [999_999_999, 10_000, 999_999_999],
  ])("%i x %i bps is %i", (amount, bps, expected) => {
    expect(mulBps(amount, bps)).toBe(expected);
  });

  it("rounds per load, never on a total: two loads of 1 cent at 50% pay 1 + 1", () => {
    expect(sum([mulBps(1, 5_000), mulBps(1, 5_000)])).toBe(2);
    expect(mulBps(2, 5_000)).toBe(1);
  });

  it("refuses basis points outside 0 to 10000 or not whole", () => {
    expect(() => mulBps(100, 10_001)).toThrow(InputError);
    expect(() => mulBps(100, -1)).toThrow(InputError);
    expect(() => mulBps(100, 0.5)).toThrow(InputError);
  });
});

describe("safe integers", () => {
  it("asserts every product, sum and difference is a safe integer", () => {
    expect(mul(500, 62)).toBe(31_000);
    expect(() => mul(2 ** 30, 2 ** 30)).toThrow(/safe integer/);
    expect(() => mul(1.5, 2)).toThrow(/safe integer/);
    expect(() => sum([Number.MAX_SAFE_INTEGER, 1])).toThrow(/safe integer/);
    expect(() => sum([1, Number.NaN])).toThrow(/safe integer/);
    expect(sum([])).toBe(0);
    expect(sub(100, 250)).toBe(-150);
    expect(() => sub(-Number.MAX_SAFE_INTEGER, 1)).toThrow(/safe integer/);
    expect(cents(-500)).toBe(-500);
    expect(() => cents(0.1 + 0.2)).toThrow(/safe integer/);
  });

  it("accepts a stored amount only from 0 to under 10^9 cents", () => {
    expect(assertCents(0, "x")).toBe(0);
    expect(assertCents(999_999_999, "x")).toBe(999_999_999);
    for (const bad of [-1, 1_000_000_000, 1.25, "100", null, undefined, Number.NaN]) {
      expect(() => assertCents(bad, "amount")).toThrow(InputError);
    }
  });

  it("accepts a count only as a non-negative whole number", () => {
    expect(assertCount(0, "miles")).toBe(0);
    for (const bad of [-1, 2.5, "3", null]) {
      expect(() => assertCount(bad, "miles")).toThrow(/miles is not a whole number/);
    }
  });
});
