// Dates for display. A date-only value ("2026-10-28") is a calendar day, so it is formatted from
// its digits and never parsed into a Date (which would shift it by the reader's zone). An instant
// is formatted in the carrier's named time zone, never the browser's.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Day = { year: number; month: number; day: number };

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isRealDay(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function parseLocalDate(value: string): Day {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new RangeError("a date must be YYYY-MM-DD");
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isRealDay(year, month, day)) throw new RangeError("a date must be a real calendar day");
  return { year, month, day };
}

// "2026-10-28" is "Oct 28, 2026".
export function formatLocalDate(value: string): string {
  const d = parseLocalDate(value);
  return `${MONTHS[d.month - 1]} ${d.day}, ${d.year}`;
}

// "Oct 26 to Nov 1, 2026"; the year shows once unless the period crosses one.
export function formatPeriod(start: string, end: string): string {
  const a = parseLocalDate(start);
  const b = parseLocalDate(end);
  if (end < start) throw new RangeError("a period cannot end before it starts");
  const head = `${MONTHS[a.month - 1]} ${a.day}`;
  const tail = `${MONTHS[b.month - 1]} ${b.day}, ${b.year}`;
  return a.year === b.year ? `${head} to ${tail}` : `${head}, ${a.year} to ${tail}`;
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

// Date.parse rolls an impossible value forward (Feb 30 becomes Mar 2, hour 24 the next day), so
// every part is checked against its own range first.
function isRealInstant(iso: string): boolean {
  const m = INSTANT.exec(iso);
  if (!m) return false;
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const [offsetHour, offsetMinute] = m[7] === undefined ? [0, 0] : [Number(m[7]), Number(m[8])];
  return (
    isRealDay(year, month, day) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    !Number.isNaN(Date.parse(iso))
  );
}

// "2026-10-28T20:12:00Z" in America/Chicago is "Oct 28, 2026, 3:12 PM CDT". The input must carry
// its zone (Z or an offset); the output always names the zone it is shown in.
export function formatInstant(iso: string, timeZone: string): string {
  if (!isRealInstant(iso)) {
    throw new RangeError("an instant must be an ISO timestamp with a zone");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("year")}, ${get("hour")}:${get("minute")} ${get("dayPeriod")} ${get("timeZoneName")}`;
}

// "America/New_York" reads "Eastern time": the zone's everyday name, the same in summer and winter.
// A zone with no such name (UTC, or an id the runtime does not know) reads as the last part of its
// id ("Etc/UTC" reads "UTC", "Mars/Olympus_Mons" reads "Olympus Mons time"). An offset id is the
// exception: "Etc/GMT+5" is five hours behind UTC (the id's sign is reversed), so it reads as the
// offset the runtime gives, "UTC-05:00", never as its own id.
export function zoneName(timeZone: string, at: Date): string {
  let generic = "";
  try {
    generic =
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    // An id the runtime does not know falls through to its own words below.
  }
  const named = /^([A-Za-z][A-Za-z -]*?)(?: Standard)? Time$/.exec(generic);
  if (named) return `${named[1]} time`;
  const city = (timeZone.split("/").pop() ?? "").replace(/_/g, " ").trim();
  if (!city) return "Local time";
  if (/^(UTC|GMT|UCT|Zulu|Universal)$/i.test(city)) return "UTC";
  if (/^(UTC|GMT)[+-]\d/i.test(city)) {
    const offset = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(generic);
    if (!offset) return "Local time";
    const [, sign, hours, minutes = "00"] = offset;
    return Number(hours) === 0 && Number(minutes) === 0 ? "UTC" : `UTC${sign}${hours.padStart(2, "0")}:${minutes}`;
  }
  return `${city} time`;
}
