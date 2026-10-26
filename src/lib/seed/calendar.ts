import { assertLocalDate, type Instant, type LocalDate } from "../time/local-date";

// The one piece of calendar math the seed needs that the engine does not: turning a local wall
// time on a date into an instant. Everything else (addDays, periodContaining, localDateOf, ...)
// comes from src/lib/time/local-date.ts, the same functions the pay math uses.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(zone, f);
  }
  return f;
}

// The wall-clock parts of an instant in a zone, as if that wall time were UTC.
function wallMs(ms: number, zone: string): number {
  const p: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) p[part.type] = part.value;
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}

// The instant at hour:minute local time on a date in a zone, as an ISO string ending in Z. A wall
// time that does not exist or happens twice (the DST hours) throws; the seed only uses 05:00 to
// 21:59, which is never one of them in the two demo zones.
export function instantAt(date: LocalDate, hour: number, minute: number, zone: string): Instant {
  assertLocalDate(date, "date");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError("hour out of range");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RangeError("minute out of range");
  }
  const [y, m, d] = date.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hour, minute);
  let ms = wanted - (wallMs(wanted, zone) - wanted);
  ms = wanted - (wallMs(ms, zone) - ms);
  if (wallMs(ms, zone) !== wanted) throw new RangeError("that local time does not exist");
  if (wallMs(ms - 3_600_000, zone) === wanted || wallMs(ms + 3_600_000, zone) === wanted) {
    throw new RangeError("that local time happens twice");
  }
  return new Date(ms).toISOString();
}
