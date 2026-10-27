// The facility time zones the portal knows, and the short label it prints next to every stamp.
// The model reports the label it read; this code, never the model, turns label and wall time into
// an instant.

export const FACILITY_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
] as const;
export type FacilityZone = (typeof FACILITY_ZONES)[number];

export const ZONE_LABELS = ["ET", "CT", "MT", "PT", "AZ"] as const;
export type ZoneLabel = (typeof ZONE_LABELS)[number];

const LABEL_OF: Record<FacilityZone, ZoneLabel> = {
  "America/New_York": "ET",
  "America/Chicago": "CT",
  "America/Denver": "MT",
  "America/Los_Angeles": "PT",
  "America/Phoenix": "AZ",
};

const ZONE_OF: Record<ZoneLabel, FacilityZone> = {
  ET: "America/New_York",
  CT: "America/Chicago",
  MT: "America/Denver",
  PT: "America/Los_Angeles",
  AZ: "America/Phoenix",
};

export const isFacilityZone = (v: unknown): v is FacilityZone =>
  typeof v === "string" && (FACILITY_ZONES as readonly string[]).includes(v);

export const labelOf = (zone: FacilityZone): ZoneLabel => LABEL_OF[zone];
export const zoneOf = (label: ZoneLabel): FacilityZone => ZONE_OF[label];

const WALL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const MINUTE_MS = 60_000;

function parts(ms: number, zone: string): number[] {
  const out = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(out.find((p) => p.type === type)?.value);
  return [get("year"), get("month"), get("day"), get("hour"), get("minute")];
}

// "2026-10-22 14:05": the instant's wall time in the zone, 24-hour, to the minute.
export function wallTime(instant: string, zone: FacilityZone): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error("not an instant");
  const [y, mo, d, h, mi] = parts(ms, zone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${y}-${two(mo)}-${two(d)} ${two(h)}:${two(mi)}`;
}

// "2026-10-22 14:05 CT", as the portal prints a stamp.
export function stampText(instant: string, zone: FacilityZone): string {
  return `${wallTime(instant, zone)} ${labelOf(zone)}`;
}

// The one instant whose wall time in the zone is the given text, as an ISO string. Null when the
// text is not a valid wall time, or when it names no instant or two (the hour skipped or repeated
// at a daylight saving change): an ambiguous stamp is not evidence.
export function instantOf(wall: string, zone: FacilityZone): string | null {
  const m = WALL.exec(wall);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const found = new Set<number>();
  // Every offset a US zone uses lies within these hours; each candidate is checked exactly.
  for (let offsetHours = 3; offsetHours <= 11; offsetHours++) {
    const ms = asUtc + offsetHours * 60 * MINUTE_MS;
    const [cy, cmo, cd, ch, cmi] = parts(ms, zone);
    if (cy === y && cmo === mo && cd === d && ch === h && cmi === mi) found.add(ms);
  }
  if (found.size !== 1) return null;
  return new Date([...found][0]).toISOString();
}
