import { describe, expect, it } from "vitest";
import { localHourOf, snoozeUntil } from "./snooze";

// "Not now" math on fixed clocks: the carrier's next 09:00 local, or 4 hours if that is sooner,
// with the 09:00 read in the carrier's named zone on both daylight saving changes of 2026.

const at = (iso: string) => Date.parse(iso);
const until = (iso: string, zone: string) => new Date(snoozeUntil(at(iso), zone)).toISOString();

describe("snoozeUntil", () => {
  it("is 4 hours later when the next 09:00 is further off", () => {
    // 10:00 CST: tomorrow's 09:00 is 23 hours off.
    expect(until("2026-11-02T16:00:00.000Z", "America/Chicago")).toBe("2026-11-02T20:00:00.000Z");
    // 22:00 CST the evening before.
    expect(until("2026-11-03T04:00:00.000Z", "America/Chicago")).toBe("2026-11-03T08:00:00.000Z");
  });

  it("is the carrier's 09:00 when that comes first", () => {
    // 06:00 CST: 09:00 CST is 15:00Z.
    expect(until("2026-11-02T12:00:00.000Z", "America/Chicago")).toBe("2026-11-02T15:00:00.000Z");
    // 07:30 EST in New York: 09:00 EST is 14:00Z.
    expect(until("2026-11-02T12:30:00.000Z", "America/New_York")).toBe("2026-11-02T14:00:00.000Z");
    // Exactly 4 hours before 09:00: the two agree.
    expect(until("2026-11-02T11:00:00.000Z", "America/Chicago")).toBe("2026-11-02T15:00:00.000Z");
  });

  it("reads 09:00 on the day the clocks fall back", () => {
    // Sunday Nov 1, 2026, 05:30 CST (the change was at 02:00 CDT): 09:00 CST is 15:00Z, not 14:00Z.
    expect(until("2026-11-01T11:30:00.000Z", "America/Chicago")).toBe("2026-11-01T15:00:00.000Z");
    expect(until("2026-11-01T10:30:00.000Z", "America/New_York")).toBe("2026-11-01T14:00:00.000Z");
  });

  it("reads 09:00 on the day the clocks spring forward", () => {
    // Sunday Mar 8, 2026, 06:00 CDT: 09:00 CDT is 14:00Z, not 15:00Z.
    expect(until("2026-03-08T11:00:00.000Z", "America/Chicago")).toBe("2026-03-08T14:00:00.000Z");
    expect(until("2026-03-08T10:00:00.000Z", "America/New_York")).toBe("2026-03-08T13:00:00.000Z");
  });

  it("refuses a clock that does not read", () => {
    expect(() => snoozeUntil(Number.NaN, "America/Chicago")).toThrow(RangeError);
  });
});

describe("localHourOf", () => {
  it("finds the instant of a local hour on each side of a change", () => {
    expect(new Date(localHourOf("2026-10-31", 9, "America/Chicago")).toISOString()).toBe("2026-10-31T14:00:00.000Z");
    expect(new Date(localHourOf("2026-11-02", 9, "America/Chicago")).toISOString()).toBe("2026-11-02T15:00:00.000Z");
  });

  it("lands on the skip for an hour the clock jumps over", () => {
    // 02:00 does not exist in Chicago on Mar 8, 2026: the clock goes from 01:59 CST to 03:00 CDT.
    expect(new Date(localHourOf("2026-03-08", 2, "America/Chicago")).toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });

  it("refuses a date that does not read", () => {
    expect(() => localHourOf("2026-13-01", 9, "America/Chicago")).toThrow();
  });
});
