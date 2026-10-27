import { describe, expect, it } from "vitest";
import { formatInstant, formatLocalDate, formatPeriod, zoneName } from "./dates";

describe("formatLocalDate", () => {
  it("formats a calendar day from its digits, with no zone shift", () => {
    expect(formatLocalDate("2026-10-28")).toBe("Oct 28, 2026");
    expect(formatLocalDate("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatLocalDate("2028-02-29")).toBe("Feb 29, 2028");
  });

  it("refuses a malformed or impossible day", () => {
    for (const bad of ["2026-13-01", "2026-02-29", "2026-1-01", "Oct 28", "2026-10-28T00:00:00Z"]) {
      expect(() => formatLocalDate(bad)).toThrow(RangeError);
    }
  });
});

describe("formatPeriod", () => {
  it("names the year once inside one year, across a month boundary", () => {
    expect(formatPeriod("2026-10-26", "2026-11-01")).toBe("Oct 26 to Nov 1, 2026");
  });

  it("names both years when the period crosses one", () => {
    expect(formatPeriod("2026-12-28", "2027-01-03")).toBe("Dec 28, 2026 to Jan 3, 2027");
  });

  it("refuses a period that ends before it starts", () => {
    expect(() => formatPeriod("2026-11-01", "2026-10-26")).toThrow(RangeError);
  });
});

describe("formatInstant", () => {
  it("shows the repeated hour on the fall-back night in each named zone", () => {
    // 06:30 UTC on Nov 1, 2026 is the second 1:30 AM in New York and the first in Chicago.
    expect(formatInstant("2026-11-01T06:30:00Z", "America/New_York")).toBe(
      "Nov 1, 2026, 1:30 AM EST",
    );
    expect(formatInstant("2026-11-01T06:30:00Z", "America/Chicago")).toBe(
      "Nov 1, 2026, 1:30 AM CDT",
    );
  });

  it("accepts an offset and shows the carrier's zone, not the input's", () => {
    expect(formatInstant("2026-10-28T15:12:00-05:00", "America/Chicago")).toBe(
      "Oct 28, 2026, 3:12 PM CDT",
    );
  });

  it("refuses an instant without a zone and an unknown zone", () => {
    expect(() => formatInstant("2026-10-28 20:12:00", "America/Chicago")).toThrow(RangeError);
    expect(() => formatInstant("2026-10-28T20:12:00", "America/Chicago")).toThrow(RangeError);
    expect(() => formatInstant("2026-10-28T20:12:00Z", "Mars/Olympus")).toThrow(RangeError);
  });

  it("refuses an impossible day or clock time instead of rolling it forward", () => {
    for (const bad of [
      "2026-02-30T10:00:00Z",
      "2026-02-29T10:00:00Z",
      "2026-13-01T10:00:00Z",
      "2026-10-28T24:00:00Z",
      "2026-10-28T24:00Z",
      "2026-10-28T23:60:00Z",
      "2026-10-28T23:59:60Z",
      "2026-10-28T10:00:00+24:00",
      "2026-10-28T10:00:00-05:60",
    ]) {
      expect(() => formatInstant(bad, "America/Chicago"), bad).toThrow(
        new RangeError("an instant must be an ISO timestamp with a zone"),
      );
    }
    expect(formatInstant("2028-02-29T23:59:59Z", "UTC")).toBe("Feb 29, 2028, 11:59 PM UTC");
  });
});

describe("zoneName", () => {
  const summer = new Date("2026-07-01T12:00:00Z");
  const winter = new Date("2026-01-15T12:00:00Z");

  it("names a carrier's zone the way people say it, the same in summer and winter", () => {
    for (const at of [summer, winter]) {
      expect(zoneName("America/New_York", at)).toBe("Eastern time");
      expect(zoneName("America/Chicago", at)).toBe("Central time");
      expect(zoneName("America/Denver", at)).toBe("Mountain time");
      expect(zoneName("America/Los_Angeles", at)).toBe("Pacific time");
    }
  });

  it("drops Standard from a zone with no daylight time", () => {
    expect(zoneName("America/Phoenix", summer)).toBe("Mountain time");
  });

  it("reads UTC as UTC and an unknown id as the last part of it, never a raw id", () => {
    expect(zoneName("UTC", summer)).toBe("UTC");
    expect(zoneName("Etc/UTC", summer)).toBe("UTC");
    expect(zoneName("Mars/Olympus_Mons", summer)).toBe("Olympus Mons time");
    expect(zoneName("", summer)).toBe("Local time");
  });
});
