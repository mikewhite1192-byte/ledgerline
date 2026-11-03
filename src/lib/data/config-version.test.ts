import { describe, expect, it } from "vitest";
import { ConfigError } from "../rules-engine";
import { checkVersionOf, configFor, configForDay, firstPeriodOf, sortVersions } from "./config-version";

// A version as the selector sees it: its date, the week shape and an id to tell versions apart.
const version = (id: string, effective_from: string, week_start_dow = 1) => ({
  id,
  effective_from,
  week_start_dow,
});

// Blue Ridge's weeks start on Monday, Prairie Wind's on Sunday, as in the seed.
const BLUE_RIDGE = [version("br-1", "2026-10-05"), version("br-2", "2026-10-19")];
const PRAIRIE_WIND = [version("pw-1", "2026-10-04", 0)];

function refuses(run: () => unknown, code: string) {
  expect(run).toThrow(ConfigError);
  expect(run).toThrow(code);
}

describe("configFor", () => {
  it("picks the newest version dated on or before the period start", () => {
    const picked = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"].map(
      (start) => configFor(BLUE_RIDGE, start).id,
    );
    expect(picked).toEqual(["br-1", "br-1", "br-2", "br-2"]);
    expect(configFor(PRAIRIE_WIND, "2026-10-25").id).toBe("pw-1");
  });

  it("reads the versions in date order, whatever order they arrive in", () => {
    const reversed = [...BLUE_RIDGE].reverse();
    expect(configFor(reversed, "2026-10-12").id).toBe("br-1");
    expect(sortVersions(reversed).map((v) => v.id)).toEqual(["br-1", "br-2"]);
  });

  it("refuses a period that starts before the first version", () => {
    refuses(() => configFor(BLUE_RIDGE, "2026-09-28"), "no_config_for_period");
    refuses(() => configFor(PRAIRIE_WIND, "2026-09-27"), "no_config_for_period");
  });

  it("applies a change dated mid-period from the next period start", () => {
    // Wednesday Oct 28 falls inside the week of Oct 26, which keeps the version it started under.
    const midWeek = [...BLUE_RIDGE, version("br-3", "2026-10-28")];
    expect(configFor(midWeek, "2026-10-26").id).toBe("br-2");
    expect(configFor(midWeek, "2026-11-02").id).toBe("br-3");
  });

  it("starts a change dated Nov 2 on each tenant's next period start", () => {
    // Blue Ridge's week of Nov 2 to 8 starts on the date; Prairie Wind's week of Nov 1 began the
    // day before, so its first week under the change is Nov 8 to 14.
    const br = [...BLUE_RIDGE, version("br-3", "2026-11-02")];
    const pw = [...PRAIRIE_WIND, version("pw-2", "2026-11-02", 0)];
    expect(configFor(br, "2026-11-02").id).toBe("br-3");
    expect(configFor(pw, "2026-11-01").id).toBe("pw-1");
    expect(configFor(pw, "2026-11-08").id).toBe("pw-2");
  });

  it("refuses a date that does not start a period", () => {
    refuses(() => configFor(BLUE_RIDGE, "2026-10-06"), "not_a_period_start");
    refuses(() => configFor(PRAIRIE_WIND, "2026-10-05"), "not_a_period_start");
    expect(() => configFor(BLUE_RIDGE, "2026-10-5")).toThrow(RangeError);
  });

  it("refuses an empty list, two versions on one date and a changed week shape", () => {
    refuses(() => configFor([], "2026-10-05"), "no_pay_config");
    const twice = [...BLUE_RIDGE, version("br-3", "2026-10-19")];
    refuses(() => configFor(twice, "2026-10-26"), "duplicate_effective_from");
    const sunday = [...BLUE_RIDGE, version("br-3", "2026-11-01", 0)];
    refuses(() => configFor(sunday, "2026-10-26"), "week_start_changed");
    expect(() => sortVersions([version("br-x", "2026-02-30")])).toThrow(RangeError);
  });
});

describe("firstPeriodOf", () => {
  it("is the version's own date when it starts a period", () => {
    expect(BLUE_RIDGE.map((v) => firstPeriodOf(BLUE_RIDGE, v))).toEqual(["2026-10-05", "2026-10-19"]);
    expect(firstPeriodOf(PRAIRIE_WIND, PRAIRIE_WIND[0])).toBe("2026-10-04");
  });

  it("is the next period start for a version dated mid-period, the week configFor first picks it", () => {
    // Wednesday Oct 28 under Monday weeks first runs the week of Nov 2; Nov 2 under Sunday weeks
    // first runs the week of Nov 8.
    const br3 = version("br-3", "2026-10-28");
    const br = [...BLUE_RIDGE, br3];
    expect(firstPeriodOf(br, br3)).toBe("2026-11-02");
    expect(configFor(br, "2026-11-02").id).toBe("br-3");
    const pw2 = version("pw-2", "2026-11-02", 0);
    expect(firstPeriodOf([...PRAIRIE_WIND, pw2], pw2)).toBe("2026-11-08");
  });

  it("is null for a version a later one replaces before its first period starts", () => {
    // Oct 28 and Oct 30 both first reach the week of Nov 2, which runs under the Oct 30 version.
    const [br3, br4] = [version("br-3", "2026-10-28"), version("br-4", "2026-10-30")];
    const br = [...BLUE_RIDGE, br3, br4];
    expect(firstPeriodOf(br, br3)).toBeNull();
    expect(firstPeriodOf(br, br4)).toBe("2026-11-02");
    expect(firstPeriodOf(br, BLUE_RIDGE[1])).toBe("2026-10-19");
  });
});

describe("configForDay", () => {
  it("judges a day under the version of the period that holds it", () => {
    const midWeek = [...BLUE_RIDGE, version("br-3", "2026-10-28")];
    expect(configForDay(midWeek, "2026-10-30").id).toBe("br-2");
    expect(configForDay(midWeek, "2026-11-01").id).toBe("br-2");
    expect(configForDay(midWeek, "2026-11-02").id).toBe("br-3");
    const pw = [...PRAIRIE_WIND, version("pw-2", "2026-11-02", 0)];
    expect(configForDay(pw, "2026-11-07").id).toBe("pw-1");
    expect(configForDay(pw, "2026-11-08").id).toBe("pw-2");
  });

  it("refuses a day whose period starts before the first version, even after its date", () => {
    // Oct 4 is a Sunday, so for Blue Ridge it closes the week of Sep 28.
    refuses(() => configForDay(BLUE_RIDGE, "2026-10-04"), "no_config_for_period");
    const late = [version("br-1", "2026-10-07")];
    refuses(() => configForDay(late, "2026-10-08"), "no_config_for_period");
    expect(configForDay(late, "2026-10-12").id).toBe("br-1");
    refuses(() => configForDay([], "2026-10-12"), "no_pay_config");
  });
});

describe("checkVersionOf", () => {
  const period = (period_start: string, status: "open" | "paid") => ({ period_start, status });

  it("reads the open period's version", () => {
    const periods = [period("2026-10-05", "paid"), period("2026-10-12", "open")];
    expect(checkVersionOf(BLUE_RIDGE, periods).id).toBe("br-1");
  });

  it("reads the newest version when no period is open", () => {
    expect(checkVersionOf(BLUE_RIDGE, [period("2026-10-05", "paid")]).id).toBe("br-2");
    expect(checkVersionOf([...BLUE_RIDGE].reverse(), []).id).toBe("br-2");
    refuses(() => checkVersionOf([], []), "no_pay_config");
  });

  it("reads the newest open period's version when two are open", () => {
    const periods = [period("2026-10-26", "open"), period("2026-10-12", "open")];
    expect(checkVersionOf(BLUE_RIDGE, periods).id).toBe("br-2");
    expect(checkVersionOf(BLUE_RIDGE, [...periods].reverse()).id).toBe("br-2");
    const before = [period("2026-10-05", "open"), period("2026-10-12", "open")];
    expect(checkVersionOf(BLUE_RIDGE, before).id).toBe("br-1");
  });
});
