import { localDateOf, localTimeOf } from "../time/local-date";
import type { ClipReading, ClockReading } from "./schema";

// Whether the clocks read from a clip agree with the stop times the load already holds. The
// stored times are the record; this only says "matches" or "differs" next to them, and nothing
// here ever changes a time or a number.

export const AGREEMENT_TOLERANCE_MINUTES = 5;

// The stored stop's instants and the carrier's zone. A null instant is unknown, never midnight.
export type StopTimes = { zone: string; arrivedAt: string | null; departedAt: string | null };

export type AgreementResult = "matches" | "differs" | "no_clock" | "no_times";

export type Agreement = {
  result: AgreementResult;
  // Minutes between the clock read and the stored time, when both exist.
  arrivalMinutesOff: number | null;
  departureMinutesOff: number | null;
};

const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?: ?([AP])M)?$/;
const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const DAY_MINUTES = 24 * 60;

// Minutes after midnight, or null when the text is not a real clock time. With AM or PM the hour
// is 1 to 12; without, it is read as a 24-hour clock.
export function clockMinutes(text: string): number | null {
  const m = CLOCK.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute > 59 || (m[3] !== undefined && Number(m[3]) > 59)) return null;
  if (m[4]) {
    if (hour < 1 || hour > 12) return null;
    return ((hour % 12) + (m[4] === "P" ? 12 : 0)) * 60 + minute;
  }
  return hour > 23 ? null : hour * 60 + minute;
}

// "10/22/2026" as 2026-10-22, or null when it is not a calendar date.
export function clipDate(text: string): string | null {
  const m = DATE.exec(text);
  if (!m) return null;
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type Side = { minutesOff: number | null; agrees: boolean };

// One clock against one stored instant: the minute gap on a 24-hour circle, and whether it is
// within the tolerance with the date (when the clip shows one) the same local day. A clock that
// is not a real time differs, with no gap to show.
function compare(clock: ClockReading, instant: string, zone: string): Side {
  const read = clockMinutes(clock.clockText);
  const local = localTimeOf(instant, zone);
  if (read === null) return { minutesOff: null, agrees: false };
  const gap = Math.abs(read - (local.hour * 60 + local.minute));
  const minutesOff = Math.min(gap, DAY_MINUTES - gap);
  const dateAgrees = clock.dateText === null || clipDate(clock.dateText) === localDateOf(instant, zone);
  return { minutesOff, agrees: dateAgrees && minutesOff <= AGREEMENT_TOLERANCE_MINUTES };
}

export function agreementOf(reading: ClipReading, times: StopTimes): Agreement {
  const pairs: [ClockReading | null, string | null][] = [
    [reading.arrival, times.arrivedAt],
    [reading.departure, times.departedAt],
  ];
  if (pairs.every(([clock]) => clock === null)) {
    return { result: "no_clock", arrivalMinutesOff: null, departureMinutesOff: null };
  }
  const sides = pairs.map(([clock, instant]) =>
    clock && instant ? compare(clock, instant, times.zone) : null,
  );
  const [arrival, departure] = sides;
  const offs = {
    arrivalMinutesOff: arrival?.minutesOff ?? null,
    departureMinutesOff: departure?.minutesOff ?? null,
  };
  if (pairs.some(([clock, instant]) => clock !== null && instant === null)) {
    return { result: "no_times", ...offs };
  }
  const agrees = sides.every((s) => s === null || s.agrees);
  return { result: agrees ? "matches" : "differs", ...offs };
}
