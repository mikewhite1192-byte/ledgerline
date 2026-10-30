import { describe, expect, it } from "vitest";
import {
  addDays,
  assertLocalDate,
  datesBetween,
  daysBetween,
  dayOfWeek,
  isLocalDate,
  isWithin,
  localDateOf,
  parseInstant,
  periodContaining,
  quarterContaining,
} from "./local-date";

const NY = "America/New_York";
const CHI = "America/Chicago";

describe("localDateOf", () => {
  it.each([
    // US clocks fall back Sunday 2026-11-01 at 02:00 local.
    ["2026-11-02T04:30:00Z", NY, "2026-11-01"],
    ["2026-11-02T04:30:00Z", CHI, "2026-11-01"],
    ["2026-11-02T05:30:00Z", NY, "2026-11-02"],
    ["2026-11-02T05:30:00Z", CHI, "2026-11-01"],
    // The repeated hour: 01:30 happens twice in New York, both on Nov 1.
    ["2026-11-01T05:30:00Z", NY, "2026-11-01"],
    ["2026-11-01T06:30:00Z", NY, "2026-11-01"],
    ["2026-11-01T04:30:00Z", CHI, "2026-10-31"],
    // Spring forward, Sunday 2026-03-08.
    ["2026-03-08T07:30:00Z", NY, "2026-03-08"],
    ["2026-03-08T07:30:00Z", CHI, "2026-03-08"],
    ["2026-03-08T04:30:00Z", NY, "2026-03-07"],
    // Offsets and the Postgres text spelling.
    ["2026-10-28T23:30:00-05:00", NY, "2026-10-29"],
    ["2026-10-28 03:05:00+00", NY, "2026-10-27"],
    ["2026-10-28T03:05:00.123456Z", CHI, "2026-10-27"],
  ])("%s in %s is %s", (instant, zone, expected) => {
    expect(localDateOf(instant, zone)).toBe(expected);
  });

  it("refuses an instant without a zone, a malformed one, or an unknown zone", () => {
    expect(() => localDateOf("2026-10-28T14:05:00", NY)).toThrow(RangeError);
    expect(() => localDateOf("2026-10-28", NY)).toThrow(RangeError);
    expect(() => localDateOf("Oct 28 2026 14:05 GMT", NY)).toThrow(RangeError);
    expect(() => localDateOf("2026-02-30T00:00:00Z", NY)).toThrow(RangeError);
    expect(() => localDateOf("2026-10-28T24:00:00Z", NY)).toThrow(RangeError);
    expect(() => localDateOf("2026-10-28T12:00:00Z", "Mars/Olympus_Mons")).toThrow(RangeError);
    expect(() => localDateOf("2026-10-28T12:00:00Z", "")).toThrow(RangeError);
  });
});

describe("parseInstant", () => {
  it.each([
    ["2026-10-28T14:05:00Z", Date.UTC(2026, 9, 28, 14, 5, 0)],
    ["2026-10-28T14:05Z", Date.UTC(2026, 9, 28, 14, 5, 0)],
    ["2026-10-28T14:05:00.250Z", Date.UTC(2026, 9, 28, 14, 5, 0, 250)],
    ["2026-10-28T19:35:00+05:30", Date.UTC(2026, 9, 28, 14, 5, 0)],
    ["2026-10-28T09:05:00-0500", Date.UTC(2026, 9, 28, 14, 5, 0)],
    ["2026-10-28 14:05:00+00", Date.UTC(2026, 9, 28, 14, 5, 0)],
  ])("%s", (value, expected) => {
    expect(parseInstant(value)).toBe(expected);
  });

  it("refuses anything it would have to guess at", () => {
    for (const bad of [null, 0, "", "2026-10-28T14:05:00", "2026-10-28T14:60:00Z", "x"]) {
      expect(() => parseInstant(bad)).toThrow(RangeError);
    }
    expect(() => parseInstant("2026-10-28T14:05:00+15:00")).toThrow(RangeError);
  });
});

describe("calendar arithmetic", () => {
  it.each([
    ["2026-10-31", 1, "2026-11-01"],
    ["2026-11-01", 1, "2026-11-02"],
    ["2026-03-08", 1, "2026-03-09"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2026-10-26", 6, "2026-11-01"],
  ])("addDays(%s, %i) is %s", (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it.each([
    ["2026-10-04", "2026-11-02", 29],
    ["2026-11-02", "2026-10-04", -29],
    ["2026-10-28", "2026-10-28", 0],
    // Across both clock changes and a leap day, still whole days.
    ["2026-03-07", "2026-03-09", 2],
    ["2026-10-31", "2026-11-02", 2],
    ["2028-02-28", "2028-03-01", 2],
    ["2026-06-01", "2027-06-01", 365],
  ])("daysBetween(%s, %s) is %i", (from, to, expected) => {
    expect(daysBetween(from, to)).toBe(expected);
  });

  it("refuses a fractional day count or a bad date", () => {
    expect(() => addDays("2026-10-26", 0.5)).toThrow(RangeError);
    expect(() => addDays("2026-10-32", 1)).toThrow(RangeError);
    expect(() => daysBetween("2026-10-28", "2026-1-1")).toThrow(RangeError);
  });

  it.each([
    ["2026-10-26", 1],
    ["2026-10-31", 6],
    ["2026-11-01", 0],
    ["2026-11-02", 1],
  ])("%s is day %i of the week", (date, dow) => {
    expect(dayOfWeek(date)).toBe(dow);
  });

  it.each([
    // Blue Ridge weeks run Monday to Sunday, Prairie Wind's Sunday to Saturday.
    ["2026-10-28", 1, "2026-10-26", "2026-11-01"],
    ["2026-10-26", 1, "2026-10-26", "2026-11-01"],
    ["2026-11-01", 1, "2026-10-26", "2026-11-01"],
    ["2026-11-02", 1, "2026-11-02", "2026-11-08"],
    ["2026-10-31", 0, "2026-10-25", "2026-10-31"],
    ["2026-11-01", 0, "2026-11-01", "2026-11-07"],
    ["2026-11-04", 3, "2026-11-04", "2026-11-10"],
  ])("periodContaining(%s, %i) is %s to %s", (date, dow, start, end) => {
    expect(periodContaining(date, dow)).toEqual({ start, end });
  });

  it("refuses a week start that is not 0 to 6", () => {
    for (const dow of [-1, 7, 1.5]) {
      expect(() => periodContaining("2026-10-28", dow)).toThrow(RangeError);
    }
  });

  it("gives seven dates for a week that crosses a clock change", () => {
    const fall = datesBetween("2026-10-26", "2026-11-01");
    expect(fall).toHaveLength(7);
    expect(fall[0]).toBe("2026-10-26");
    expect(fall[6]).toBe("2026-11-01");
    expect(new Set(fall).size).toBe(7);
    expect(datesBetween("2026-03-02", "2026-03-08")).toHaveLength(7);
    expect(datesBetween("2026-10-28", "2026-10-28")).toEqual(["2026-10-28"]);
    expect(() => datesBetween("2026-11-01", "2026-10-26")).toThrow(RangeError);
  });

  it("counts both ends of a period as inside it", () => {
    const week = { start: "2026-10-26", end: "2026-11-01" };
    expect(isWithin("2026-10-26", week)).toBe(true);
    expect(isWithin("2026-11-01", week)).toBe(true);
    expect(isWithin("2026-10-25", week)).toBe(false);
    expect(isWithin("2026-11-02", week)).toBe(false);
    expect(() => isWithin("2026-11-2", week)).toThrow(RangeError);
  });
});

describe("isLocalDate", () => {
  it("accepts only a real date in YYYY-MM-DD", () => {
    expect(isLocalDate("2026-10-28")).toBe(true);
    expect(isLocalDate("2028-02-29")).toBe(true);
    for (const bad of [
      "2026-2-03",
      "2026-02-30",
      "2027-02-29",
      "26-01-01",
      "0099-01-01",
      "2026-10-28T00:00:00Z",
      " 2026-10-28",
      20261028,
      null,
    ]) {
      expect(isLocalDate(bad)).toBe(false);
    }
    expect(() => assertLocalDate("2026-13-01", "day")).toThrow(/day is not a YYYY-MM-DD date/);
  });
});

describe("quarterContaining", () => {
  it("quarterContaining gives Oct 1 to Dec 31 for Nov 2 and Jan 1 to Mar 31 for Mar 31", () => {
    expect(quarterContaining("2026-11-02")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(quarterContaining("2027-03-31")).toEqual({ start: "2027-01-01", end: "2027-03-31" });
  });

  it("puts each quarter's first and last day inside it, in a leap year too", () => {
    expect(quarterContaining("2028-01-01")).toEqual({ start: "2028-01-01", end: "2028-03-31" });
    expect(quarterContaining("2028-02-29")).toEqual({ start: "2028-01-01", end: "2028-03-31" });
    expect(quarterContaining("2026-04-01")).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(quarterContaining("2026-06-30")).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(quarterContaining("2026-07-01")).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(quarterContaining("2026-09-30")).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(quarterContaining("2026-12-31")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
  });

  it("refuses a date that is not YYYY-MM-DD", () => {
    expect(() => quarterContaining("2026-11-2")).toThrow(RangeError);
  });
});
