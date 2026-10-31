import { describe, expect, it } from "vitest";
import { clocksOf, instantOfLocal, isLocalClock, localClockOf, resolve } from "./clocks";

const ZONE = "America/Chicago";

describe("the two-clock rule", () => {
  it("takes the day from the local clock and the moment from the utc clock", () => {
    // 11:30 PM local on Nov 2 is 05:30 UTC on Nov 3: the day stays Nov 2.
    const r = resolve({ utc: "2026-11-03T05:30:00.000Z", local: "2026-11-02T23:30" }, ZONE);
    expect(r).toEqual({ day: "2026-11-02", at: "2026-11-03T05:30:00.000Z", flag: null });
  });

  it("keeps the utc moment when a hand edit moved only the local clock by hours", () => {
    const r = resolve({ utc: "2026-11-02T20:14:00.000Z", local: "2026-11-02T09:00" }, ZONE);
    expect(r.at).toBe("2026-11-02T20:14:00.000Z");
    expect(r.day).toBe("2026-11-02");
    expect(r.flag).toBeNull();
  });

  it("reads the local clock in the carrier's zone when there is no utc clock", () => {
    const r = resolve({ utc: null, local: "2026-11-02T14:14" }, ZONE);
    expect(r).toEqual({ day: "2026-11-02", at: "2026-11-02T20:14:00.000Z", flag: null });
  });

  it("flags a pair more than one day apart and never flags one inside a day", () => {
    const far = resolve({ utc: "2026-11-05T20:14:00.000Z", local: "2026-11-02T14:14" }, ZONE);
    expect(far.flag).toBe("clocks_disagree");
    expect(far.day).toBe("2026-11-02");
    const near = resolve({ utc: "2026-11-03T19:00:00.000Z", local: "2026-11-02T14:14" }, ZONE);
    expect(near.flag).toBeNull();
  });

  it("normalizes a utc clock given with an offset", () => {
    const r = resolve({ utc: "2026-11-02T14:14:00-06:00", local: "2026-11-02T14:14" }, ZONE);
    expect(r.at).toBe("2026-11-02T20:14:00.000Z");
  });

  it("refuses a local clock that is not a wall time", () => {
    expect(isLocalClock("2026-11-02T24:00")).toBe(false);
    expect(isLocalClock("2026-02-30T10:00")).toBe(false);
    expect(isLocalClock("2026-11-02 10:00")).toBe(false);
    expect(isLocalClock("2026-11-02T10:00")).toBe(true);
    expect(() => resolve({ utc: null, local: "11/02/2026 10:00" }, ZONE)).toThrow(RangeError);
  });

  it("reads a wall time the zone skips at the day's noon offset", () => {
    // Mar 8 2026, 2:30 AM does not exist in Chicago.
    expect(instantOfLocal("2026-03-08T02:30", ZONE)).toBe("2026-03-08T07:30:00.000Z");
  });

  it("round trips an instant through both clocks", () => {
    const pair = clocksOf("2026-11-02T20:14:00Z", ZONE);
    expect(pair).toEqual({ utc: "2026-11-02T20:14:00.000Z", local: "2026-11-02T14:14" });
    expect(localClockOf("2026-11-02T20:14:00.000Z", ZONE)).toBe("2026-11-02T14:14");
    expect(resolve(pair, ZONE)).toEqual({ day: "2026-11-02", at: "2026-11-02T20:14:00.000Z", flag: null });
  });
});
