import { formatCents } from "../format/money";
import type { DriverInsight } from "../reports/driver-insights";
import type { CentsLeader, CountLeader, DriverLeaders } from "../reports/types";
import { compareText } from "../rules-engine";

// The drivers list page's query (design-d1-drivers 4.4): each value matched whole against its
// allowed list, anything else the default; the search box's text; the rows filtered, searched and
// sorted in memory; and the leaders line.

export const LIST_LIMIT = 200;
export const SEARCH_MAX = 60;

export const STATUSES = ["active", "departed", "all"] as const;
export const ARMED = ["all", "yes", "no"] as const;
export const DAYS = ["28", "90", "365"] as const;
export const SORTS = ["net", "gross", "loads", "miles", "owed", "code"] as const;

export type Status = (typeof STATUSES)[number];
export type Armed = (typeof ARMED)[number];
export type Days = (typeof DAYS)[number];
export type Sort = (typeof SORTS)[number];
export type Filters = { status: Status; armed: Armed; days: Days; sort: Sort; q: string };

export const DEFAULTS: Filters = { status: "active", armed: "all", days: "28", sort: "net", q: "" };

export const STATUS_WORDS: Readonly<Record<Status, string>> = { active: "Active", departed: "Departed", all: "All" };
export const ARMED_WORDS: Readonly<Record<Armed, string>> = { all: "Any", yes: "Armed", no: "Not armed" };
export const SORT_WORDS: Readonly<Record<Sort, string>> = {
  net: "Net pay",
  gross: "Gross",
  loads: "Loads",
  miles: "Miles",
  owed: "Owed",
  code: "Code",
};

// One of the allowed values, matched whole; anything else (absent, repeated, unknown) is the default.
function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" ? (allowed.find((a) => a === value) ?? fallback) : fallback;
}

// The search text is kept only up to 60 characters; a longer one is not a search.
export function filtersOf(params: Record<string, string | string[] | undefined>): Filters {
  const q = typeof params.q === "string" && params.q.length <= SEARCH_MAX ? params.q.trim() : "";
  return {
    status: pick(params.status, STATUSES, DEFAULTS.status),
    armed: pick(params.armed, ARMED, DEFAULTS.armed),
    days: pick(params.days, DAYS, DEFAULTS.days),
    sort: pick(params.sort, SORTS, DEFAULTS.sort),
    q,
  };
}

// The page's own link for a set of filters; a default value is left out.
export function hrefFor(f: Filters): string {
  const parts: string[] = [];
  for (const key of ["status", "armed", "days", "sort", "q"] as const) {
    if (f[key] !== DEFAULTS[key]) parts.push(`${key}=${encodeURIComponent(f[key])}`);
  }
  return parts.length > 0 ? `/drivers?${parts.join("&")}` : "/drivers";
}

export const miles = (r: DriverInsight): number => r.loadedMiles + r.emptyMiles;
export const nameOf = (r: DriverInsight): string => `${r.driver.firstName} ${r.driver.lastName}`;
export const count = (n: number): string => n.toLocaleString("en-US");

const SORT_VALUE: Readonly<Record<Exclude<Sort, "code">, (r: DriverInsight) => number>> = {
  net: (r) => r.netCents,
  gross: (r) => r.grossCents,
  loads: (r) => r.loads,
  miles,
  owed: (r) => r.owedCents,
};

// The search box: the typed text, lowercased, inside the lowercased code or name. A person's
// search over the rows already read, never an identifier compare; nothing is written from it.
// Largest first, ties to the lower code; by code, lowest first.
export function listRows(rows: readonly DriverInsight[], f: Filters): DriverInsight[] {
  const needle = f.q.toLowerCase();
  const kept = rows.filter((r) => {
    if (f.status === "active" && r.departed) return false;
    if (f.status === "departed" && !r.departed) return false;
    if (f.armed === "yes" && !r.driver.moneyArmed) return false;
    if (f.armed === "no" && r.driver.moneyArmed) return false;
    if (needle === "") return true;
    return r.driver.code.toLowerCase().includes(needle) || nameOf(r).toLowerCase().includes(needle);
  });
  const byCode = (a: DriverInsight, b: DriverInsight) => compareText(a.driver.code, b.driver.code);
  if (f.sort === "code") return kept.sort(byCode);
  const value = SORT_VALUE[f.sort];
  return kept.sort((a, b) => value(b) - value(a) || byCode(a, b));
}

const leaderName = (l: CentsLeader | CountLeader): string => l.driver.label;

// One line of text from the leaders: no chart, the agent stays the main feature.
export function leadersLine(days: Days, leaders: DriverLeaders): string {
  const parts: string[] = [];
  if (leaders.topNet) parts.push(`top net ${leaderName(leaders.topNet)} ${formatCents(leaders.topNet.valueCents)}`);
  if (leaders.mostLoads) parts.push(`most loads ${leaderName(leaders.mostLoads)} ${count(leaders.mostLoads.value)}`);
  if (leaders.mostMiles) parts.push(`most miles ${leaderName(leaders.mostMiles)} ${count(leaders.mostMiles.value)}`);
  if (leaders.mostOwed) parts.push(`most owed ${leaderName(leaders.mostOwed)} ${formatCents(leaders.mostOwed.valueCents)}`);
  if (parts.length === 0) return `Last ${days} days: no paid paystubs, deliveries or amounts owed yet.`;
  return `Last ${days} days: ${parts.join(", ")}.`;
}
