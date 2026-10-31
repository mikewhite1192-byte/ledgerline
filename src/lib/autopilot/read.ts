import { DbError, type Queryable } from "../db";
import { localMidnightOf } from "../desk/keys";
import { isLocalDate, localDateOf } from "../time/local-date";
import { isUuid } from "../uuid";
import type { DayTotals, PauseFacts, RuleFacts } from "./policy";

// The autopilot's reads, each inside a tenant transaction the caller opened. A read that does not
// answer in the expected shape throws (unknown is not zero); the caller fails closed.

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const RULE_SQL = `SELECT CAST(id AS text) AS id, kind, mode, CAST(max_cents AS text) AS max_cents,
       CAST(day_max_cents AS text) AS day_max_cents, day_max_count, version,
       CAST(driver_day_max_cents AS text) AS driver_day_max_cents
  FROM autopilot_rules WHERE tenant_id = current_tenant_id() AND kind = $1`;

type RuleRow = {
  id: unknown;
  kind: unknown;
  mode: unknown;
  max_cents: unknown;
  day_max_cents: unknown;
  day_max_count: unknown;
  version: unknown;
  driver_day_max_cents: unknown;
};

const cents = (v: unknown): number => (typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : Number.NaN);

// The owner's rule for one kind, or null when there is none. lock: held until the caller's
// transaction ends, so two approvals of the same kind read today's totals one after the other.
export async function readRule(q: Queryable, kind: string, lock: boolean): Promise<RuleFacts | null> {
  const rows = await q.query<RuleRow>(lock ? `${RULE_SQL} FOR UPDATE` : RULE_SQL, [kind]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new DbError("unknown");
  const r = rows[0];
  if (!isUuid(r.id) || typeof r.kind !== "string" || typeof r.mode !== "string") throw new DbError("unknown");
  return {
    id: r.id.toLowerCase(),
    kind: r.kind,
    mode: r.mode,
    maxCents: cents(r.max_cents),
    dayMaxCents: cents(r.day_max_cents),
    dayMaxCount: typeof r.day_max_count === "number" ? r.day_max_count : Number.NaN,
    version: typeof r.version === "number" ? r.version : Number.NaN,
    // Null on a rule with no driver limit; anything else that does not read is no limit at all.
    driverDayMaxCents: r.driver_day_max_cents === null ? null : cents(r.driver_day_max_cents),
  };
}

const PAUSE_SQL = `SELECT ${ts("paused_at")} AS paused_at, ${ts("paused_until")} AS paused_until, paused_by
  FROM autopilot_state WHERE tenant_id = current_tenant_id()`;

export type PauseRow = PauseFacts & { pausedBy: string | null };

const instantMs = (v: unknown): number | null => (v === null ? null : typeof v === "string" ? Date.parse(v) : Number.NaN);

// The carrier's pause row, or null when it has none (not paused).
export async function readPause(q: Queryable): Promise<PauseRow | null> {
  const rows = await q.query<{ paused_at: unknown; paused_until: unknown; paused_by: unknown }>(PAUSE_SQL, []);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new DbError("unknown");
  const r = rows[0];
  return {
    pausedAtMs: instantMs(r.paused_at),
    pausedUntilMs: instantMs(r.paused_until),
    pausedBy: typeof r.paused_by === "string" ? r.paused_by : null,
  };
}

const ZONE_SQL = "SELECT timezone FROM tenants WHERE id = current_tenant_id()";

export async function readZone(q: Queryable): Promise<string> {
  const rows = await q.query<{ timezone: unknown }>(ZONE_SQL, []);
  if (rows.length !== 1 || typeof rows[0].timezone !== "string") throw new DbError("unknown");
  return rows[0].timezone;
}

// The carrier's local midnight on a date, in ms; NaN when the date does not read.
export function midnightMs(date: string, zone: string): number {
  if (!isLocalDate(date)) return Number.NaN;
  try {
    return Date.parse(localMidnightOf(date, zone));
  } catch {
    return Number.NaN;
  }
}

// Today's start in the carrier's zone, as an ISO instant.
export function todayStartIso(now: Date, zone: string): string {
  return localMidnightOf(localDateOf(now.toISOString(), zone), zone);
}

// What the autopilot approved today for one kind: every proposal its login decided with an auto
// decision since the carrier's local midnight, whatever happened after (an unknown outcome counts
// as spent). A query over the proposals, never a counter row.
const TODAY_SQL = `SELECT CAST(COALESCE(sum(amount_cents), 0) AS text) AS cents, CAST(count(*) AS integer) AS n
  FROM proposals
 WHERE tenant_id = current_tenant_id() AND kind = $1 AND decided_by = $2
   AND autopilot_decision->>'mode' = 'auto' AND decided_at >= CAST($3 AS timestamptz)`;

// The same totals for one driver alone, on a kind that pays a driver: the proposals whose args name
// that driver, compared as the whole canonical id (both money kinds store it there, checked by
// their executors).
const DRIVER_TODAY_SQL = `${TODAY_SQL} AND args->>'driverId' = $4`;

export async function readToday(q: Queryable, kind: string, sub: string, sinceIso: string): Promise<DayTotals> {
  return totalsOf(await q.query<{ cents: unknown; n: unknown }>(TODAY_SQL, [kind, sub, sinceIso]));
}

export async function readDriverToday(
  q: Queryable,
  kind: string,
  sub: string,
  sinceIso: string,
  driverId: string,
): Promise<DayTotals> {
  return totalsOf(await q.query<{ cents: unknown; n: unknown }>(DRIVER_TODAY_SQL, [kind, sub, sinceIso, driverId]));
}

function totalsOf(rows: { cents: unknown; n: unknown }[]): DayTotals {
  if (rows.length !== 1) throw new DbError("unknown");
  const c = cents(rows[0].cents);
  const n = rows[0].n;
  if (!Number.isSafeInteger(c) || typeof n !== "number" || !Number.isSafeInteger(n)) throw new DbError("unknown");
  return { cents: c, count: n };
}
