import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import { rateOn, type PinnedRate } from "../rules-engine/rates";
import { addDays, isLocalDate, localDateOf } from "../time/local-date";
import { isUuid } from "../uuid";
import { RATE_KINDS, type RateKind } from "./candidates";
import { perGallonText } from "./format";
import { isRateState, stateName } from "./states";

// The reads behind the Fuel and tax rates page and the agent's get_pinned_rates. Every statement
// names the tenant as well as relying on row-level security, so a login that bypasses it still
// reads one carrier only.

export const LOOKUP_PURPOSE = "rate_lookup";
export const DAY_MS = 86_400_000;

export type Member = { id: string; role: "admin" | "staff" };

// The signed-in person's membership in this carrier, or null.
export async function memberOf(q: Queryable, sub: string): Promise<Member | null> {
  const rows = await q.query<{ id: unknown; role: unknown }>(
    `SELECT CAST(id AS text) AS id, role FROM memberships
      WHERE tenant_id = current_tenant_id() AND cognito_sub = $1`,
    [sub],
  );
  if (rows.length !== 1) return null;
  const [r] = rows;
  if (!isUuid(r.id) || (r.role !== "admin" && r.role !== "staff")) return null;
  return { id: r.id, role: r.role };
}

// The carrier's own time zone and today in it.
export async function carrierToday(q: Queryable, now: Date): Promise<{ zone: string; today: string } | null> {
  const rows = await q.query<{ timezone: unknown }>("SELECT timezone FROM tenants WHERE id = current_tenant_id()");
  if (rows.length !== 1 || typeof rows[0].timezone !== "string") return null;
  const zone = rows[0].timezone;
  return { zone, today: localDateOf(now.toISOString(), zone) };
}

// Lookups this carrier started in the rolling day before now, from the spend ledger by purpose,
// so a call that never answered still counts. A row stamped after now counts too: another lookup's
// reservation, stamped by the database's clock a moment after this request read its own, is never
// left out.
export async function lookupsInDay(q: Queryable, now: Date): Promise<number> {
  const rows = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM model_calls
      WHERE tenant_id = current_tenant_id() AND purpose = $1 AND created_at > CAST($2 AS timestamptz)`,
    [LOOKUP_PURPOSE, new Date(now.getTime() - DAY_MS).toISOString()],
  );
  const n = Number(rows[0]?.n);
  if (rows.length !== 1 || !Number.isSafeInteger(n) || n < 0) throw new Error("unreadable lookup count");
  return n;
}

// A day an admin may pin a rate from: up to a year back, and never after today. A new pin retires
// the live one at once, so a later start would leave the days before it with no rate at all (pins
// that start later are not in this release).
export function effectiveDayOk(day: unknown, today: string): day is string {
  return isLocalDate(day) && day >= addDays(today, -366) && day <= today;
}

type RateRow = {
  id: string;
  kind: string;
  state: string | null;
  status: string;
  value_mcents: number | string | null;
  source: string;
  source_url: string;
  source_title: string | null;
  quote: string | null;
  as_of: string | null;
  effective_from: string | null;
  created_by: string;
  pinned_by: string | null;
  pinned_at: string | null;
  retired_at: string | null;
  created_at: string;
};

const COLUMNS = `CAST(id AS text) AS id, kind, state, status, value_mcents, source, source_url, source_title, quote,
  CAST(as_of AS text) AS as_of, CAST(effective_from AS text) AS effective_from,
  CAST(created_by AS text) AS created_by, CAST(pinned_by AS text) AS pinned_by,
  to_char(pinned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS pinned_at,
  to_char(retired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS retired_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

export type RateView = {
  id: string;
  kind: RateKind;
  state: string | null;
  status: "suggested" | "unconfirmed" | "pinned";
  valueMcents: number | null;
  perGallon: string | null;
  sourceUrl: string;
  sourceTitle: string | null;
  sourceHost: string;
  quote: string | null;
  asOf: string | null;
  effectiveFrom: string | null;
  // The pin's instant (UTC), and its day in the carrier's time zone.
  pinnedAt: string | null;
  pinnedOn: string | null;
  byYou: boolean;
  typed: boolean;
  createdAt: string;
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function viewOf(r: RateRow, zone: string, you: string): RateView {
  if (!(RATE_KINDS as readonly string[]).includes(r.kind)) throw new Error("unknown rate kind");
  if (r.status !== "suggested" && r.status !== "unconfirmed" && r.status !== "pinned") throw new Error("unknown status");
  const kind = r.kind as RateKind;
  const value = r.value_mcents === null ? null : Number(r.value_mcents);
  if (value !== null && !Number.isSafeInteger(value)) throw new Error("unreadable rate");
  return {
    id: r.id,
    kind,
    state: r.state,
    status: r.status,
    valueMcents: value,
    perGallon: value === null ? null : perGallonText(kind, value),
    sourceUrl: r.source_url,
    sourceTitle: r.source_title,
    sourceHost: hostOf(r.source_url),
    quote: r.quote,
    asOf: r.as_of,
    effectiveFrom: r.effective_from,
    pinnedAt: r.pinned_at,
    pinnedOn: r.pinned_at ? localDateOf(r.pinned_at, zone) : null,
    byYou: (r.status === "pinned" ? r.pinned_by : r.created_by) === you,
    typed: r.source === "typed",
    createdAt: r.created_at,
  };
}

export type RateSlot = { pinned: RateView | null; suggestion: RateView | null };
export type StateSlot = RateSlot & { code: string; name: string };

export type RatesPage = {
  today: string;
  canPin: boolean;
  lookupsLeft: number;
  diesel: RateSlot;
  states: StateSlot[];
};

const slotKey = (kind: string, state: string | null) => `${kind}:${state ?? "--"}`;

// The page: each live pin, and the latest lookup for each kind and state when it is newer than
// that pin and was not pinned. Null when the person has no membership here.
export async function readRatesPage(q: Queryable, sub: string, now: Date): Promise<RatesPage | null> {
  const member = await memberOf(q, sub);
  const day = await carrierToday(q, now);
  if (!member || !day) return null;
  const pins = await q.query<RateRow>(
    `SELECT ${COLUMNS} FROM pinned_rates
      WHERE tenant_id = current_tenant_id() AND status = 'pinned' AND retired_at IS NULL`,
  );
  const latest = await q.query<RateRow>(
    `SELECT DISTINCT ON (kind, COALESCE(state, '--')) ${COLUMNS} FROM pinned_rates
      WHERE tenant_id = current_tenant_id() AND source = 'lookup'
      ORDER BY kind, COALESCE(state, '--'), created_at DESC, id DESC`,
  );
  const crossed = await q.query<{ state: string }>(
    "SELECT DISTINCT state FROM load_state_miles WHERE tenant_id = current_tenant_id()",
  );
  const used = await lookupsInDay(q, now);

  const slots = new Map<string, RateSlot>();
  const slot = (kind: string, state: string | null) => {
    const key = slotKey(kind, state);
    const found = slots.get(key);
    if (found) return found;
    const fresh: RateSlot = { pinned: null, suggestion: null };
    slots.set(key, fresh);
    return fresh;
  };
  for (const r of pins) slot(r.kind, r.state).pinned = viewOf(r, day.zone, member.id);
  for (const r of latest) {
    if (r.status === "pinned") continue;
    const s = slot(r.kind, r.state);
    if (s.pinned?.pinnedAt && r.created_at <= s.pinned.pinnedAt) continue;
    s.suggestion = viewOf(r, day.zone, member.id);
  }

  const codes = new Set<string>();
  for (const r of crossed) if (isRateState(r.state)) codes.add(r.state);
  for (const r of [...pins, ...latest]) if (r.kind === "ifta_rate" && isRateState(r.state)) codes.add(r.state);
  const states = [...codes]
    .map((code) => ({ code, name: stateName(code), ...slot("ifta_rate", code) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    today: day.today,
    canPin: member.role === "admin",
    lookupsLeft: Math.max(0, flags.ratesLimits.lookupsPerTenantPerDay - used),
    diesel: slot("diesel_index", null),
    states,
  };
}

export type PinnedRateAnswer = {
  id: string;
  kind: RateKind;
  state: string | null;
  perGallon: string;
  valueMcents: number;
  sourceTitle: string | null;
  sourceUrl: string;
  effectiveFrom: string;
  pinnedOn: string;
  typed: boolean;
};

// The pinned rate in effect on a day for one kind (and one state, or every pinned state when a
// fuel tax rate names none), through the engine's rateOn. Never a suggestion.
export async function readPinnedRates(
  q: Queryable,
  kind: RateKind,
  state: string | null,
  day: string,
  zone: string,
): Promise<PinnedRateAnswer[]> {
  if (state !== null && !isRateState(state)) return [];
  const rows = await q.query<RateRow>(
    `SELECT ${COLUMNS} FROM pinned_rates
      WHERE tenant_id = current_tenant_id() AND status = 'pinned' AND retired_at IS NULL AND kind = $1
      ORDER BY state NULLS FIRST, effective_from, id`,
    [kind],
  );
  const pinned: PinnedRate[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    state: r.state,
    status: r.status,
    valueMcents: r.value_mcents === null ? null : Number(r.value_mcents),
    effectiveFrom: r.effective_from,
    retiredAt: r.retired_at,
  }));
  const states = kind === "diesel_index" ? [null] : state !== null ? [state] : [...new Set(rows.map((r) => r.state))];
  const out: PinnedRateAnswer[] = [];
  for (const s of states) {
    const hit = rateOn(pinned, kind, s, day);
    if (!hit) continue;
    const row = rows.find((r) => r.id === hit.id) as RateRow;
    const value = hit.valueMcents as number;
    out.push({
      id: hit.id,
      kind,
      state: hit.state,
      perGallon: perGallonText(kind, value),
      valueMcents: value,
      sourceTitle: row.source_title,
      sourceUrl: row.source_url,
      effectiveFrom: hit.effectiveFrom as string,
      pinnedOn: localDateOf(row.pinned_at as string, zone),
      typed: row.source === "typed",
    });
  }
  return out;
}
