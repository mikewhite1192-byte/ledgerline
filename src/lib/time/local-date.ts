// Calendar dates as `YYYY-MM-DD` strings in a tenant's own zone. Pay math only ever sees these,
// never an instant, so a daylight saving change cannot move a load or a day between weeks.
// Calendar arithmetic runs on Date.UTC of the date parts, which has no DST by construction.
// Nothing here reads the clock.

export type LocalDate = string;
// An ISO 8601 instant with an explicit zone: `2026-10-28T14:05:00Z` or `...-05:00`.
export type Instant = string;
// Both ends inclusive.
export type Period = { start: LocalDate; end: LocalDate };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

function parts(value: string): [number, number, number] | null {
  const m = DATE.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Date.UTC maps years 0 to 99 onto the 1900s, so those fail the round trip too.
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return [y, mo, d];
}

function format(t: Date): LocalDate {
  const y = String(t.getUTCFullYear()).padStart(4, "0");
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// A real calendar date in the one accepted spelling; `2026-02-30` and `2026-11-1` are not.
export function isLocalDate(value: unknown): value is LocalDate {
  return typeof value === "string" && parts(value) !== null;
}

export function assertLocalDate(value: unknown, what: string): LocalDate {
  if (!isLocalDate(value)) throw new RangeError(`${what} is not a YYYY-MM-DD date`);
  return value;
}

function utc(date: LocalDate): Date {
  const p = parts(date);
  if (!p) throw new RangeError("not a YYYY-MM-DD date");
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
}

export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isSafeInteger(days)) throw new RangeError("days must be a whole number");
  const t = utc(date);
  return format(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + days)));
}

// Whole days from one date to another, negative when `to` is earlier. Both are UTC midnights, so
// the difference is an exact multiple of a day.
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return (utc(to).getTime() - utc(from).getTime()) / 86_400_000;
}

// 0 is Sunday, 6 is Saturday.
export function dayOfWeek(date: LocalDate): number {
  return utc(date).getUTCDay();
}

// The week holding `date`, for a tenant whose weeks start on `weekStartDow`.
export function periodContaining(date: LocalDate, weekStartDow: number): Period {
  if (!Number.isInteger(weekStartDow) || weekStartDow < 0 || weekStartDow > 6) {
    throw new RangeError("weekStartDow must be 0 to 6");
  }
  const back = (dayOfWeek(date) - weekStartDow + 7) % 7;
  const start = addDays(date, -back);
  return { start, end: addDays(start, 6) };
}

// Every date from start to end, both included.
export function datesBetween(start: LocalDate, end: LocalDate): LocalDate[] {
  assertLocalDate(start, "start");
  assertLocalDate(end, "end");
  if (end < start) throw new RangeError("end is before start");
  const out: LocalDate[] = [start];
  while (out[out.length - 1] !== end) out.push(addDays(out[out.length - 1], 1));
  return out;
}

export function isWithin(date: LocalDate, period: Period): boolean {
  assertLocalDate(date, "date");
  assertLocalDate(period.start, "period start");
  assertLocalDate(period.end, "period end");
  return period.start <= date && date <= period.end;
}

// Milliseconds since the epoch. An instant without a zone is ambiguous and refused, and so is
// anything Date.parse would guess at.
export function parseInstant(value: unknown): number {
  if (typeof value !== "string") throw new RangeError("instant is not a string");
  const m = INSTANT.exec(value);
  if (!m) throw new RangeError("instant is not ISO 8601 with a zone");
  const p = parts(m[1]);
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  const second = Number(m[4] ?? "0");
  const millis = Number((m[5] ?? "").padEnd(3, "0").slice(0, 3));
  if (!p || hour > 23 || minute > 59 || second > 59) throw new RangeError("instant out of range");
  let offsetMinutes = 0;
  if (m[6] !== "Z") {
    const oh = Number(m[8]);
    const om = Number(m[9] ?? "0");
    if (oh > 14 || om > 59) throw new RangeError("instant offset out of range");
    offsetMinutes = (m[7] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const local = Date.UTC(p[0], p[1] - 1, p[2], hour, minute, second, millis);
  return local - offsetMinutes * 60_000;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    // Throws RangeError for a zone the runtime does not know.
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

// The calendar date an instant falls on in an IANA zone (the tenant's `timezone`).
export function localDateOf(instant: Instant, zone: string): LocalDate {
  if (typeof zone !== "string" || zone.length === 0) throw new RangeError("zone is required");
  const t = new Date(parseInstant(instant));
  const out: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(t)) out[part.type] = part.value;
  return assertLocalDate(`${out.year}-${out.month}-${out.day}`, "local date");
}
