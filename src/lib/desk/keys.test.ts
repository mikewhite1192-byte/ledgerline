import { describe, expect, it } from "vitest";
import {
  DESK_SOURCES,
  duePeriodKeys,
  dueToday,
  eventKey,
  isoWeekOf,
  isRerunSource,
  localMidnightOf,
  localNowOf,
  MAX_PERIOD_GO,
  parseEventKey,
  periodGoKey,
  periodGoOf,
  periodKey,
  SUBJECT_TABLES,
} from "./keys";

const ID = "6B1C9D2E-3F4A-4B5C-8D6E-7F8A9B0C1D2E";

describe("event keys", () => {
  it("names a subject row by its source and lower-case id, and refuses anything else", () => {
    expect(eventKey("card_transaction", ID)).toBe(`card_transaction:${ID.toLowerCase()}`);
    expect(eventKey("audit", ID.toLowerCase())).toBe(`audit:${ID.toLowerCase()}`);
    expect(() => eventKey("card_transaction", "acme")).toThrow(RangeError);
    expect(() => eventKey("sweep" as never, ID)).toThrow(RangeError);
  });

  it("reads back only the keys this loop writes", () => {
    const id = ID.toLowerCase();
    expect(parseEventKey(`voice_note:${id}`)).toEqual({ source: "voice_note", subjectId: id });
    expect(parseEventKey("sweep:2026-10-31")).toEqual({ source: "sweep", subjectId: null });
    expect(parseEventKey("collections:2026-11-02")).toEqual({ source: "collections", subjectId: null });
    expect(parseEventKey("cash_check:2026-W44")).toEqual({ source: "cash_check", subjectId: null });
    expect(parseEventKey("sweep:2026-10-31.2")).toEqual({ source: "sweep", subjectId: null });
    expect(parseEventKey("sweep:2026-10-31.99")).toEqual({ source: "sweep", subjectId: null });
    for (const bad of [
      "sweep:2026-10-31.1",
      "sweep:2026-10-31.0",
      "sweep:2026-10-31.02",
      "sweep:2026-10-31.100",
      "sweep:2026-10-31.",
      "sweep:2026-10-31.2.2",
      "collections:2026-11-02.2",
      "cash_check:2026-W44.2",
      `voice_note:${id}.2`,
      `voice_note:${ID}`,
      "voice_note:acme",
      "sweep:2026-W44",
      "cash_check:2026-10-30",
      "cash_check:2026-W54",
      "cash_check:2026-W00",
      `fuel:${id}`,
      `:${id}`,
      "sweep",
      "",
      "x".repeat(121),
      null,
      42,
    ]) {
      expect(parseEventKey(bad)).toBeNull();
    }
  });

  it("numbers a period's later goes, only for a source whose run the demo reset can remove", () => {
    expect(isRerunSource("sweep")).toBe(true);
    expect(isRerunSource("collections")).toBe(false);
    expect(isRerunSource("cash_check")).toBe(false);
    expect(periodGoKey("sweep:2026-10-31", 1)).toBe("sweep:2026-10-31");
    expect(periodGoKey("sweep:2026-10-31", 2)).toBe("sweep:2026-10-31.2");
    expect(periodGoKey("sweep:2026-10-31", MAX_PERIOD_GO)).toBe("sweep:2026-10-31.99");
    for (const bad of [0, MAX_PERIOD_GO + 1, 1.5, Number.NaN]) {
      expect(() => periodGoKey("sweep:2026-10-31", bad)).toThrow(RangeError);
    }
    expect(periodGoOf("sweep:2026-10-31", "sweep:2026-10-31")).toBe(1);
    expect(periodGoOf("sweep:2026-10-31.2", "sweep:2026-10-31")).toBe(2);
    expect(periodGoOf("sweep:2026-10-31.42", "sweep:2026-10-31")).toBe(42);
    for (const bad of ["sweep:2026-10-31.1", "sweep:2026-10-31.02", "sweep:2026-10-311", "sweep:2026-10-30.2", null, 7]) {
      expect(periodGoOf(bad, "sweep:2026-10-31")).toBeNull();
    }
  });

  it("maps every subject source to its own table, and every source is a desk source", () => {
    for (const source of Object.keys(SUBJECT_TABLES)) expect(DESK_SOURCES).toContain(source);
    // A proposal is two pieces of work under two keys (its audit, then the autopilot's look); every
    // other table belongs to one source.
    const others = Object.entries(SUBJECT_TABLES).filter(([source]) => source !== "autopilot");
    expect(new Set(others.map(([, table]) => table)).size).toBe(others.length);
    expect(SUBJECT_TABLES.autopilot).toBe("proposals");
    expect(SUBJECT_TABLES.audit).toBe("proposals");
  });

  it("keeps a proposal's audit key and its autopilot key apart", () => {
    const id = "1a2b3c4d-0000-4000-8000-00000000000a";
    expect(eventKey("audit", id)).not.toBe(eventKey("autopilot", id));
    expect(parseEventKey(eventKey("autopilot", id))).toEqual({ source: "autopilot", subjectId: id });
  });
});

describe("ISO weeks", () => {
  it("puts dates near New Year in the week that holds their Thursday", () => {
    expect(isoWeekOf("2026-01-01")).toBe("2026-W01");
    expect(isoWeekOf("2026-10-30")).toBe("2026-W44");
    expect(isoWeekOf("2026-12-28")).toBe("2026-W53");
    expect(isoWeekOf("2026-12-31")).toBe("2026-W53");
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
    expect(isoWeekOf("2027-01-04")).toBe("2027-W01");
    expect(isoWeekOf("2024-12-30")).toBe("2025-W01");
    expect(isoWeekOf("2021-01-03")).toBe("2020-W53");
  });

  it("refuses a date that is not a calendar date", () => {
    expect(() => isoWeekOf("2026-02-30")).toThrow();
    expect(() => isoWeekOf("10/30/2026")).toThrow();
  });
});

describe("due periods", () => {
  it("makes the sweep due from 05:00 and collections from 06:00 on the carrier's own clock", () => {
    expect(dueToday("sweep", { date: "2026-10-31", hour: 4 })).toBe(false);
    expect(dueToday("sweep", { date: "2026-10-31", hour: 5 })).toBe(true);
    expect(dueToday("collections", { date: "2026-10-31", hour: 5 })).toBe(false);
    expect(dueToday("collections", { date: "2026-10-31", hour: 6 })).toBe(true);
  });

  it("makes the morning digest due every day from 06:00, keyed by the local date", () => {
    expect(dueToday("digest", { date: "2026-10-31", hour: 5 })).toBe(false);
    expect(dueToday("digest", { date: "2026-10-31", hour: 6 })).toBe(true);
    expect(dueToday("digest", { date: "2026-11-01", hour: 23 })).toBe(true);
    expect(periodKey("digest", "2026-11-06")).toBe("digest:2026-11-06");
    expect(parseEventKey("digest:2026-11-06")).toEqual({ source: "digest", subjectId: null });
    expect(parseEventKey("digest:2026-W45")).toBeNull();
    expect(parseEventKey("digest:2026-11-06.2")).toBeNull();
  });

  it("makes the cash check due on Fridays from 06:00 only, keyed by the ISO week", () => {
    expect(dueToday("cash_check", { date: "2026-10-30", hour: 5 })).toBe(false);
    expect(dueToday("cash_check", { date: "2026-10-30", hour: 6 })).toBe(true);
    expect(dueToday("cash_check", { date: "2026-10-31", hour: 23 })).toBe(false);
    expect(dueToday("cash_check", { date: "2026-11-05", hour: 12 })).toBe(false);
    expect(periodKey("cash_check", "2026-11-06")).toBe("cash_check:2026-W45");
    expect(periodKey("sweep", "2026-11-06")).toBe("sweep:2026-11-06");
  });

  it("lists what is due in a fixed order, and nothing before the start date", () => {
    expect(duePeriodKeys({ date: "2026-11-06", hour: 7 }, "2026-10-31")).toEqual([
      { source: "sweep", key: "sweep:2026-11-06" },
      { source: "collections", key: "collections:2026-11-06" },
      { source: "cash_check", key: "cash_check:2026-W45" },
      { source: "digest", key: "digest:2026-11-06" },
    ]);
    expect(duePeriodKeys({ date: "2026-10-31", hour: 5 }, "2026-10-31")).toEqual([
      { source: "sweep", key: "sweep:2026-10-31" },
    ]);
    expect(duePeriodKeys({ date: "2026-10-30", hour: 23 }, "2026-10-31")).toEqual([]);
  });
});

describe("the carrier's wall clock", () => {
  it("reads the local date and hour across the fall-back change", () => {
    // Chicago leaves daylight time at 2:00 on Nov 1, 2026: 05:00 local is 10:00 UTC before the
    // change and 11:00 UTC after it.
    expect(localNowOf("2026-10-31T09:59:00.000Z", "America/Chicago")).toEqual({ date: "2026-10-31", hour: 4 });
    expect(localNowOf("2026-10-31T10:00:00.000Z", "America/Chicago")).toEqual({ date: "2026-10-31", hour: 5 });
    expect(localNowOf("2026-11-01T10:59:00.000Z", "America/Chicago")).toEqual({ date: "2026-11-01", hour: 4 });
    expect(localNowOf("2026-11-01T11:00:00.000Z", "America/Chicago")).toEqual({ date: "2026-11-01", hour: 5 });
    expect(dueToday("sweep", localNowOf("2026-11-01T10:59:00.000Z", "America/Chicago"))).toBe(false);
    expect(dueToday("sweep", localNowOf("2026-11-01T11:00:00.000Z", "America/Chicago"))).toBe(true);
  });

  it("reads the local date and hour across the spring-forward change", () => {
    // Chicago enters daylight time on Mar 14, 2027: 05:00 local is 10:00 UTC that day.
    expect(localNowOf("2027-03-14T09:59:00.000Z", "America/Chicago")).toEqual({ date: "2027-03-14", hour: 4 });
    expect(localNowOf("2027-03-14T10:00:00.000Z", "America/Chicago")).toEqual({ date: "2027-03-14", hour: 5 });
  });

  it("uses the carrier's own date, which can differ from the UTC date", () => {
    // Mexico City keeps UTC-6 all year; Kolkata is UTC+5:30.
    expect(localNowOf("2026-11-01T03:00:00.000Z", "America/Mexico_City")).toEqual({ date: "2026-10-31", hour: 21 });
    expect(localNowOf("2026-10-30T23:30:00.000Z", "Asia/Kolkata")).toEqual({ date: "2026-10-31", hour: 5 });
    expect(duePeriodKeys(localNowOf("2026-10-30T23:30:00.000Z", "Asia/Kolkata"), "2026-10-31")).toEqual([
      { source: "sweep", key: "sweep:2026-10-31" },
    ]);
  });
});

describe("localMidnightOf", () => {
  it("gives the carrier's own midnight, on either side of a daylight change", () => {
    // Chicago: CDT (UTC-5) on Oct 31, back to CST (UTC-6) at 02:00 on Nov 1.
    expect(localMidnightOf("2026-10-31", "America/Chicago")).toBe("2026-10-31T05:00:00.000Z");
    expect(localMidnightOf("2026-11-01", "America/Chicago")).toBe("2026-11-01T05:00:00.000Z");
    expect(localMidnightOf("2026-11-02", "America/Chicago")).toBe("2026-11-02T06:00:00.000Z");
    expect(localMidnightOf("2026-10-31", "UTC")).toBe("2026-10-31T00:00:00.000Z");
    expect(localMidnightOf("2026-10-31", "Asia/Tokyo")).toBe("2026-10-30T15:00:00.000Z");
  });

  it("starts a day whose clocks skip midnight at the change", () => {
    // Santiago springs forward at midnight on Sep 6, 2026: the day starts at 01:00 local.
    expect(localMidnightOf("2026-09-06", "America/Santiago")).toBe("2026-09-06T04:00:00.000Z");
  });

  it("refuses a date that is not a calendar date", () => {
    expect(() => localMidnightOf("2026-02-30", "America/Chicago")).toThrow(RangeError);
    expect(() => localMidnightOf("Oct 31", "America/Chicago")).toThrow(RangeError);
  });
});
