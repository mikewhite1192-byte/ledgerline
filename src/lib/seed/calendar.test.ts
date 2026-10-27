import { describe, expect, it } from "vitest";
import { instantAt } from "./calendar";

const NY = "America/New_York";
const CHI = "America/Chicago";

describe("instantAt", () => {
  it("turns a local wall time into the matching instant", () => {
    expect(instantAt("2026-10-28", 9, 14, NY)).toBe("2026-10-28T13:14:00.000Z");
    expect(instantAt("2026-10-28", 9, 14, CHI)).toBe("2026-10-28T14:14:00.000Z");
    expect(instantAt("2026-11-02", 7, 0, NY)).toBe("2026-11-02T12:00:00.000Z");
    expect(instantAt("2026-11-02", 21, 59, CHI)).toBe("2026-11-03T03:59:00.000Z");
  });

  it("refuses a wall time that does not exist (spring forward)", () => {
    expect(() => instantAt("2026-03-08", 2, 30, NY)).toThrow(RangeError);
    expect(() => instantAt("2026-03-08", 2, 30, CHI)).toThrow(RangeError);
  });

  it("refuses a wall time that happens twice (fall back)", () => {
    expect(() => instantAt("2026-11-01", 1, 30, NY)).toThrow(RangeError);
    expect(() => instantAt("2026-11-01", 1, 30, CHI)).toThrow(RangeError);
  });

  it("refuses an hour or minute out of range", () => {
    expect(() => instantAt("2026-10-28", 24, 0, NY)).toThrow(RangeError);
    expect(() => instantAt("2026-10-28", 9, 60, NY)).toThrow(RangeError);
    expect(() => instantAt("2026-10-28", 9.5, 0, NY)).toThrow(RangeError);
  });
});
