import { describe, expect, it } from "vitest";
import { agreementOf, clipDate, clockMinutes, type StopTimes } from "./agreement";
import { agreementText } from "./messages";
import type { ClipReading, ClockReading } from "./schema";

const ZONE = "America/New_York";
// 4:05 AM and 11:25 AM EDT on 10/22/2026.
const TIMES: StopTimes = { zone: ZONE, arrivedAt: "2026-10-22T08:05:00.000Z", departedAt: "2026-10-22T15:25:00.000Z" };

const clock = (clockText: string, dateText: string | null = "10/22/2026"): ClockReading => ({
  clockText,
  dateText,
  atSeconds: 1,
  confidence: "high",
});
const reading = (arrival: ClockReading | null, departure: ClockReading | null): ClipReading => ({
  arrival,
  departure,
  bolNumber: null,
  sealNumber: null,
  doorText: null,
});

describe("clockMinutes", () => {
  it("reads AM and PM, a 24-hour clock and seconds, and refuses times that do not exist", () => {
    expect(clockMinutes("4:05 AM")).toBe(245);
    expect(clockMinutes("12:00 AM")).toBe(0);
    expect(clockMinutes("12:30 PM")).toBe(750);
    expect(clockMinutes("11:25PM")).toBe(23 * 60 + 25);
    expect(clockMinutes("16:05:12")).toBe(965);
    expect(clockMinutes("04:05")).toBe(245);
    expect(clockMinutes("13:05 PM")).toBeNull();
    expect(clockMinutes("0:05 AM")).toBeNull();
    expect(clockMinutes("24:00")).toBeNull();
    expect(clockMinutes("4:60 AM")).toBeNull();
    expect(clockMinutes("4:05:61")).toBeNull();
    expect(clockMinutes("four")).toBeNull();
  });
});

describe("clipDate", () => {
  it("reads MM/DD/YYYY and refuses dates that do not exist", () => {
    expect(clipDate("10/22/2026")).toBe("2026-10-22");
    expect(clipDate("1/2/2026")).toBe("2026-01-02");
    expect(clipDate("02/30/2026")).toBeNull();
    expect(clipDate("13/01/2026")).toBeNull();
    expect(clipDate("2026-10-22")).toBeNull();
  });
});

describe("agreementOf", () => {
  it("matches within five minutes on the same local day, on either clock style", () => {
    expect(agreementOf(reading(clock("4:05 AM"), clock("11:25 AM")), TIMES)).toEqual({
      result: "matches",
      arrivalMinutesOff: 0,
      departureMinutesOff: 0,
    });
    expect(agreementOf(reading(clock("04:09"), clock("11:20:59", null)), TIMES)).toEqual({
      result: "matches",
      arrivalMinutesOff: 4,
      departureMinutesOff: 5,
    });
  });

  it("differs at six minutes, or on another date, and says by how much", () => {
    const six = agreementOf(reading(clock("4:11 AM"), clock("11:25 AM")), TIMES);
    expect(six).toEqual({ result: "differs", arrivalMinutesOff: 6, departureMinutesOff: 0 });
    expect(agreementText(six)).toBe("Differs from the stored stop times (arrival 6 minutes off)");
    const day = agreementOf(reading(clock("4:05 AM", "10/23/2026"), null), TIMES);
    expect(day).toEqual({ result: "differs", arrivalMinutesOff: 0, departureMinutesOff: null });
    expect(agreementText(day)).toBe("Differs from the stored stop times");
  });

  it("measures the gap around midnight, not across the whole day", () => {
    const late: StopTimes = { zone: ZONE, arrivedAt: "2026-10-23T03:58:00.000Z", departedAt: null };
    expect(agreementOf(reading(clock("12:02 AM", null), null), late)).toEqual({
      result: "matches",
      arrivalMinutesOff: 4,
      departureMinutesOff: null,
    });
  });

  it("uses the carrier's zone, so the same instant reads differently in Chicago", () => {
    const chicago: StopTimes = { ...TIMES, zone: "America/Chicago" };
    expect(agreementOf(reading(clock("3:05 AM"), clock("10:25 AM")), chicago).result).toBe("matches");
    expect(agreementOf(reading(clock("4:05 AM"), clock("11:25 AM")), chicago).result).toBe("differs");
  });

  it("says no_clock when no clock was read and no_times when a read clock has no stored time", () => {
    expect(agreementOf(reading(null, null), TIMES)).toEqual({
      result: "no_clock",
      arrivalMinutesOff: null,
      departureMinutesOff: null,
    });
    const noDeparture: StopTimes = { ...TIMES, departedAt: null };
    expect(agreementOf(reading(clock("4:05 AM"), clock("11:25 AM")), noDeparture)).toEqual({
      result: "no_times",
      arrivalMinutesOff: 0,
      departureMinutesOff: null,
    });
    // A stored time with no clock read for it is not compared, never counted as a match or a miss.
    expect(agreementOf(reading(clock("4:05 AM"), null), TIMES).result).toBe("matches");
  });

  it("says differs when one side disagrees, even when the other side has no stored time", () => {
    const noDeparture: StopTimes = { ...TIMES, departedAt: null };
    const off = agreementOf(reading(clock("7:05 AM"), clock("11:25 AM")), noDeparture);
    expect(off).toEqual({ result: "differs", arrivalMinutesOff: 180, departureMinutesOff: null });
    expect(agreementText(off)).toBe("Differs from the stored stop times (arrival 180 minutes off)");
    const noArrival: StopTimes = { ...TIMES, arrivedAt: null };
    expect(agreementOf(reading(clock("4:05 AM"), clock("2:25 PM")), noArrival)).toEqual({
      result: "differs",
      arrivalMinutesOff: null,
      departureMinutesOff: 180,
    });
  });

  it("treats a clock that is not a real time as differing, with no gap shown", () => {
    expect(agreementOf(reading(clock("13:05 PM"), null), TIMES)).toEqual({
      result: "differs",
      arrivalMinutesOff: null,
      departureMinutesOff: null,
    });
  });
});
