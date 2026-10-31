import type { TwoClocks } from "../adapters/tms-source/types";
import { instantAt } from "../seed/calendar";
import { isLocalDate, localDateOf, localTimeOf, parseInstant, type Instant, type LocalDate } from "../time/local-date";

// TMS-MIRROR: the two-clock rule. A dispatch system stores every time twice: a UTC field that is
// often a copy of the local one (so it cannot be trusted alone) and a local field with no offset
// that hand edits change by themselves. The calendar day comes from the local field, the exact
// moment from the UTC field (or, with no UTC field, the local field read in the carrier's named
// zone), and a pair more than one day apart is flagged: no load ever moves on a flagged time.
// Pure: nothing here reads the clock or the database.

const LOCAL_CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const DAY_MS = 86_400_000;

export type ClockFlag = "clocks_disagree";
export type Resolved = { day: LocalDate; at: Instant; flag: ClockFlag | null };

// `YYYY-MM-DDTHH:mm`, a real date and a real wall time.
export function isLocalClock(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = LOCAL_CLOCK.exec(value);
  return m !== null && isLocalDate(m[1]) && Number(m[2]) <= 23 && Number(m[3]) <= 59;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

// The wall clock an instant shows in a zone, as `YYYY-MM-DDTHH:mm`.
export function localClockOf(instant: Instant, zone: string): string {
  const t = localTimeOf(instant, zone);
  return `${localDateOf(instant, zone)}T${two(t.hour)}:${two(t.minute)}`;
}

// A local clock read in a zone. A wall time the zone skips or repeats (the daylight saving hour) is
// read at that day's noon offset, so a reading always exists; the caller flags what it must.
export function instantOfLocal(local: string, zone: string): Instant {
  const m = LOCAL_CLOCK.exec(local);
  if (!m || !isLocalClock(local)) throw new RangeError("not a local clock");
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  try {
    return instantAt(m[1], hour, minute, zone);
  } catch {
    const noon = parseInstant(instantAt(m[1], 12, 0, zone));
    return new Date(noon + ((hour - 12) * 60 + minute) * 60_000).toISOString();
  }
}

// Day from local, moment from UTC, and the flag when the two are more than a day apart.
export function resolve(pair: TwoClocks, zone: string): Resolved {
  const day = pair.local.slice(0, 10);
  if (!isLocalClock(pair.local)) throw new RangeError("not a local clock");
  const fromLocal = instantOfLocal(pair.local, zone);
  if (pair.utc === null) return { day, at: fromLocal, flag: null };
  const utcMs = parseInstant(pair.utc);
  const at = new Date(utcMs).toISOString();
  const apart = Math.abs(utcMs - parseInstant(fromLocal));
  return { day, at, flag: apart > DAY_MS ? "clocks_disagree" : null };
}

// The pair for one instant with both clocks agreeing (the clean feed, and the seed).
export function clocksOf(instant: Instant, zone: string): TwoClocks {
  return { utc: new Date(parseInstant(instant)).toISOString(), local: localClockOf(instant, zone) };
}

// The wall time an instant shows in a zone, as a person reads it: "9:20 AM".
export function clockText(instant: Instant, zone: string): string {
  const t = localTimeOf(instant, zone);
  const hour = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${hour}:${two(t.minute)} ${t.hour < 12 ? "AM" : "PM"}`;
}
