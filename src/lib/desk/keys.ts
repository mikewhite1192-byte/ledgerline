import { isUuid } from "../uuid";
import { assertLocalDate, dayOfWeek, localDateOf, localTimeOf, type Instant, type LocalDate } from "../time/local-date";

// The desk loop's event keys: the subject row's id, or the period (the carrier's local day or ISO
// week). One key is one piece of work, done at most once (desk_log_done_once). Pure: nothing here
// reads the clock or the database.

export const DESK_SOURCES = [
  "card_transaction",
  "inbound_message",
  "voice_note",
  "customer_payment",
  "audit",
  "sweep",
  "collections",
  "cash_check",
] as const;
export type DeskSource = (typeof DESK_SOURCES)[number];

// A source whose work is one row, and the table that row lives in.
export const SUBJECT_TABLES = {
  card_transaction: "card_transactions",
  inbound_message: "inbound_messages",
  voice_note: "voice_notes",
  customer_payment: "customer_payments",
  audit: "proposals",
} as const;
export type SubjectSource = keyof typeof SUBJECT_TABLES;

// A source whose work is one period, and the local hour (24-hour clock) it is due from.
export const PERIOD_DUE_HOUR = { sweep: 5, collections: 6, cash_check: 6 } as const;
export type PeriodSource = keyof typeof PERIOD_DUE_HOUR;
export const PERIOD_SOURCES = Object.keys(PERIOD_DUE_HOUR) as PeriodSource[];

// Cash Friday is due on Fridays only (0 is Sunday).
const FRIDAY = 5;

export function isDeskSource(value: unknown): value is DeskSource {
  return typeof value === "string" && (DESK_SOURCES as readonly string[]).includes(value);
}

export function isSubjectSource(value: unknown): value is SubjectSource {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SUBJECT_TABLES, value);
}

export function isPeriodSource(value: unknown): value is PeriodSource {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PERIOD_DUE_HOUR, value);
}

// `card_transaction:<id>`: the subject row's id, lower case. Throws on an id that is not a uuid.
export function eventKey(source: SubjectSource, subjectId: string): string {
  if (!isSubjectSource(source)) throw new RangeError("not a subject source");
  if (!isUuid(subjectId)) throw new RangeError("subject id is not a uuid");
  return `${source}:${subjectId.toLowerCase()}`;
}

// The ISO 8601 week a date falls in, as `YYYY-Www`: weeks start on Monday, and week 1 is the one
// holding the year's first Thursday, so a date near New Year may belong to the other year's week.
export function isoWeekOf(date: LocalDate): string {
  const [y, m, d] = assertLocalDate(date, "date").split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  // Monday 0 to Sunday 6, then the Thursday of the same week.
  const mondayBased = (new Date(t).getUTCDay() + 6) % 7;
  const thursday = new Date(t + (3 - mondayBased) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const dayOfYear = (thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000;
  const week = Math.floor(dayOfYear / 7) + 1;
  return `${String(year).padStart(4, "0")}-W${String(week).padStart(2, "0")}`;
}

// The carrier's wall clock at one instant: its local date and hour.
export type LocalNow = { date: LocalDate; hour: number };

export function localNowOf(instant: Instant, zone: string): LocalNow {
  return { date: localDateOf(instant, zone), hour: localTimeOf(instant, zone).hour };
}

// The wall clock an instant shows in the zone, read as if it were UTC, in ms.
function wallClockAt(t: number, zone: string): number {
  const iso = new Date(t).toISOString();
  const [y, m, d] = localDateOf(iso, zone).split("-").map(Number);
  const time = localTimeOf(iso, zone);
  return Date.UTC(y, m - 1, d, time.hour, time.minute, time.second);
}

// The first instant of the carrier's local day `date` (its midnight in `zone`), as an ISO instant
// (UTC, milliseconds, Z): the loop's start. The zone's offset is read at a first guess and again
// at the instant that guess gives, so a change near midnight lands on the right side; on a day
// whose clocks skip midnight, the day starts at the change. Throws when neither guess is that day.
export function localMidnightOf(date: LocalDate, zone: string): Instant {
  const [y, m, d] = assertLocalDate(date, "date").split("-").map(Number);
  const midnight = Date.UTC(y, m - 1, d);
  const first = midnight - (wallClockAt(midnight, zone) - midnight);
  const second = midnight - (wallClockAt(first, zone) - first);
  const onDate = [first, second].filter((t) => localDateOf(new Date(t).toISOString(), zone) === date);
  if (onDate.length === 0) throw new RangeError("no start for that day in that zone");
  return new Date(Math.min(...onDate)).toISOString();
}

// Whether a period's work is due now: the sweep from 05:00 local each day, collections from 06:00
// local each day, the cash check from 06:00 local on Fridays.
export function dueToday(source: PeriodSource, now: LocalNow): boolean {
  if (!isPeriodSource(source)) return false;
  if (now.hour < PERIOD_DUE_HOUR[source]) return false;
  if (source === "cash_check") return dayOfWeek(now.date) === FRIDAY;
  return true;
}

// `sweep:YYYY-MM-DD`, `collections:YYYY-MM-DD`, `cash_check:YYYY-Www`: the period's key.
export function periodKey(source: PeriodSource, date: LocalDate): string {
  if (!isPeriodSource(source)) throw new RangeError("not a period source");
  if (source === "cash_check") return `cash_check:${isoWeekOf(date)}`;
  return `${source}:${assertLocalDate(date, "date")}`;
}

// The period keys due now, in a fixed order, for days on or after the loop's start date.
export function duePeriodKeys(now: LocalNow, startDate: LocalDate): { source: PeriodSource; key: string }[] {
  if (now.date < startDate) return [];
  return PERIOD_SOURCES.filter((s) => dueToday(s, now)).map((source) => ({ source, key: periodKey(source, now.date) }));
}

// The parts of a key, or null when it is not one this loop writes.
export function parseEventKey(key: unknown): { source: DeskSource; subjectId: string | null } | null {
  if (typeof key !== "string" || key.length < 1 || key.length > 120) return null;
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const source = key.slice(0, at);
  const rest = key.slice(at + 1);
  if (isSubjectSource(source)) {
    return isUuid(rest) && rest === rest.toLowerCase() ? { source, subjectId: rest } : null;
  }
  if (source === "cash_check") return /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(rest) ? { source, subjectId: null } : null;
  if (isPeriodSource(source)) return /^\d{4}-\d{2}-\d{2}$/.test(rest) ? { source, subjectId: null } : null;
  return null;
}
