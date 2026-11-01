import { describe, expect, it } from "vitest";
import { addDays, localDateOf } from "../time/local-date";
import { MAX_WEEKS_PER_ROLL, weeksToOpen } from "./roll";

// The weeks the pay sweep opens (D-090): the week holding the carrier's today, only when no period
// holds it and the pay rules have started, and every missing week before it back to the newest
// period, so the weeks stay back to back. Monday weeks are Blue Ridge's shape, Sunday weeks the
// other demo carrier's.

const MONDAY = 1;
const SUNDAY = 0;
const FIRST = "2026-01-01";
const seeded = [{ period_start: "2026-10-05" }, { period_start: "2026-10-12" }, { period_start: "2026-10-19" }, { period_start: "2026-10-26" }];

describe("weeksToOpen", () => {
  it("gives the week holding today once the newest open week has ended", () => {
    expect(weeksToOpen({ today: "2026-11-02", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded })).toEqual([
      { start: "2026-11-02", end: "2026-11-08" },
    ]);
  });

  it("gives nothing when a period already starts that week, whatever its status", () => {
    expect(weeksToOpen({ today: "2026-11-01", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded })).toEqual([]);
    expect(weeksToOpen({ today: "2026-10-26", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded })).toEqual([]);
    const opened = [...seeded, { period_start: "2026-11-02" }];
    expect(weeksToOpen({ today: "2026-11-05", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: opened })).toEqual([]);
  });

  it("gives today's week when the carrier has no period at all", () => {
    expect(weeksToOpen({ today: "2026-11-04", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: [] })).toEqual([
      { start: "2026-11-02", end: "2026-11-08" },
    ]);
  });

  it("opens every missing week back to the newest period, oldest first, so no week is skipped", () => {
    // The finals a week after a demo reset: the seeded weeks end Nov 1, today is Nov 10.
    expect(weeksToOpen({ today: "2026-11-10", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded })).toEqual([
      { start: "2026-11-02", end: "2026-11-08" },
      { start: "2026-11-09", end: "2026-11-15" },
    ]);
    // A week opened after the gap is never followed by one behind it.
    const ahead = [...seeded, { period_start: "2026-11-16" }];
    expect(weeksToOpen({ today: "2026-11-10", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: ahead })).toEqual([]);
  });

  it("opens at most a set number of weeks per start, the oldest first, and the next start goes on from there", () => {
    const first = weeksToOpen({ today: "2027-03-01", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded });
    expect(first.length).toBe(MAX_WEEKS_PER_ROLL);
    expect(first[0]).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    const after = [...seeded, ...first.map((w) => ({ period_start: w.start }))];
    const next = weeksToOpen({ today: "2027-03-01", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: after });
    expect(next[0]?.start).toBe(addDays(first[first.length - 1].start, 7));
  });

  it("starts the catch up at the first week the pay rules cover", () => {
    const old = [{ period_start: "2026-09-28" }];
    expect(weeksToOpen({ today: "2026-11-04", weekStartDow: MONDAY, firstEffectiveFrom: "2026-10-20", periods: old })).toEqual([
      { start: "2026-10-26", end: "2026-11-01" },
      { start: "2026-11-02", end: "2026-11-08" },
    ]);
  });

  it("gives nothing for a week that starts before the first pay rules version", () => {
    expect(weeksToOpen({ today: "2026-11-04", weekStartDow: MONDAY, firstEffectiveFrom: "2026-11-03", periods: [] })).toEqual([]);
    // A version dated on the week's first day applies to it.
    expect(weeksToOpen({ today: "2026-11-04", weekStartDow: MONDAY, firstEffectiveFrom: "2026-11-02", periods: [] })).toEqual([
      { start: "2026-11-02", end: "2026-11-08" },
    ]);
  });

  it("follows the carrier's week shape, Sunday weeks as well as Monday", () => {
    const sunday = [{ period_start: "2026-10-25" }];
    expect(weeksToOpen({ today: "2026-11-01", weekStartDow: SUNDAY, firstEffectiveFrom: FIRST, periods: sunday })).toEqual([
      { start: "2026-11-01", end: "2026-11-07" },
    ]);
    expect(weeksToOpen({ today: "2026-10-31", weekStartDow: SUNDAY, firstEffectiveFrom: FIRST, periods: sunday })).toEqual([]);
  });

  it("treats a period that overlaps the week as holding it", () => {
    expect(weeksToOpen({ today: "2026-11-04", weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: [{ period_start: "2026-11-01" }] })).toEqual([]);
  });

  it("reads a Chicago evening instant as the prior local day, so the week has not rolled yet", () => {
    const today = localDateOf("2026-11-02T03:00:00Z", "America/Chicago");
    expect(today).toBe("2026-11-01");
    expect(weeksToOpen({ today, weekStartDow: MONDAY, firstEffectiveFrom: FIRST, periods: seeded })).toEqual([]);
  });
});
