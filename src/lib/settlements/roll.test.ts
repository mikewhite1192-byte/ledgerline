import { describe, expect, it } from "vitest";
import { localDateOf } from "../time/local-date";
import { weekToOpen } from "./roll";

// The week the pay sweep opens (D-090): the week holding the carrier's today, only when no period
// holds it and the pay rules have started. Monday weeks are Blue Ridge's shape, Sunday weeks the
// other demo carrier's.

const MONDAY = 1;
const SUNDAY = 0;
const FIRST = "2026-01-01";
const seeded = [{ period_start: "2026-10-05" }, { period_start: "2026-10-12" }, { period_start: "2026-10-19" }, { period_start: "2026-10-26" }];

describe("weekToOpen", () => {
  it("gives the week holding today once the newest open week has ended", () => {
    expect(weekToOpen({ today: "2026-11-02", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded })).toEqual({
      start: "2026-11-02",
      end: "2026-11-08",
    });
  });

  it("gives nothing when a period already starts that week, whatever its status", () => {
    expect(weekToOpen({ today: "2026-11-01", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded })).toBeNull();
    expect(weekToOpen({ today: "2026-10-26", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded })).toBeNull();
    const opened = [...seeded, { period_start: "2026-11-02" }];
    expect(weekToOpen({ today: "2026-11-05", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: opened })).toBeNull();
  });

  it("gives today's week when the carrier has no period at all", () => {
    expect(weekToOpen({ today: "2026-11-04", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: [] })).toEqual({
      start: "2026-11-02",
      end: "2026-11-08",
    });
  });

  it("opens only today's week across a gap, never the weeks in between", () => {
    expect(weekToOpen({ today: "2026-11-10", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded })).toEqual({
      start: "2026-11-09",
      end: "2026-11-15",
    });
  });

  it("gives nothing for a week that starts before the first pay rules version", () => {
    expect(weekToOpen({ today: "2026-11-04", weekStartDow: MONDAY, firstEffectiveFrom: "2026-11-03", periods: [] })).toBeNull();
    // A version dated on the week's first day applies to it.
    expect(weekToOpen({ today: "2026-11-04", weekStartDow: MONDAY, firstEffectiveFrom: "2026-11-02", periods: [] })).toEqual({
      start: "2026-11-02",
      end: "2026-11-08",
    });
  });

  it("follows the carrier's week shape, Sunday weeks as well as Monday", () => {
    const sunday = [{ period_start: "2026-10-25" }];
    expect(weekToOpen({ today: "2026-11-01", weekStartDow: SUNDAY, firstEffectiveFrom: FIRST, periods: sunday })).toEqual({
      start: "2026-11-01",
      end: "2026-11-07",
    });
    expect(weekToOpen({ today: "2026-10-31", weekStartDow: SUNDAY, firstEffectiveFrom: FIRST, periods: sunday })).toBeNull();
  });

  it("treats a period that overlaps the week as holding it", () => {
    expect(weekToOpen({ today: "2026-11-04", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: [{ period_start: "2026-11-01" }] })).toBeNull();
  });

  it("reads a Chicago evening instant as the prior local day, so the week has not rolled yet", () => {
    const today = localDateOf("2026-11-02T03:00:00Z", "America/Chicago");
    expect(today).toBe("2026-11-01");
    expect(weekToOpen({ today, weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded })).toBeNull();
  });
});
