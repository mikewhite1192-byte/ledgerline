import { addDays, assertLocalDate, localDateOf, localTimeOf } from "../time/local-date";

// "Not now" on a question: it comes back at the carrier's next 09:00 local time, or in 4 hours if
// that is sooner. The carrier's named time zone decides the 09:00, so a daylight saving change
// moves the instant, never the wall clock. Pure.

export const SNOOZE_HOURS = 4;
export const WAKE_HOUR = 9;

// The wall clock an instant shows in the zone, read as if it were UTC, in ms.
function wallClockAt(t: number, zone: string): number {
  const iso = new Date(t).toISOString();
  const [y, m, d] = localDateOf(iso, zone).split("-").map(Number);
  const time = localTimeOf(iso, zone);
  return Date.UTC(y, m - 1, d, time.hour, time.minute, time.second);
}

// The instant the zone's clock shows `hour`:00 on `date`. The offset is read at a first guess and
// again at the instant that guess gives, so a change between midnight and the hour lands right.
export function localHourOf(date: string, hour: number, zone: string): number {
  const [y, m, d] = assertLocalDate(date, "date").split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hour);
  const first = wall - (wallClockAt(wall, zone) - wall);
  const second = wall - (wallClockAt(first, zone) - first);
  if (wallClockAt(second, zone) === wall) return second;
  if (wallClockAt(first, zone) === wall) return first;
  // The hour does not exist that day (a clock skip): the instant the skip lands on.
  return Math.max(first, second);
}

// When a question snoozed at `nowMs` comes back, in ms since the epoch.
export function snoozeUntil(nowMs: number, zone: string): number {
  if (!Number.isFinite(nowMs)) throw new RangeError("no clock");
  const iso = new Date(nowMs).toISOString();
  const today = localDateOf(iso, zone);
  const todayAt = localHourOf(today, WAKE_HOUR, zone);
  const nextNine = todayAt > nowMs ? todayAt : localHourOf(addDays(today, 1), WAKE_HOUR, zone);
  return Math.min(nextNine, nowMs + SNOOZE_HOURS * 3_600_000);
}
