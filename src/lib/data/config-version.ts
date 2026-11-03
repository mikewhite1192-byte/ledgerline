import { compareText, ConfigError } from "../rules-engine";
import { addDays, assertLocalDate, dayOfWeek, periodContaining, type LocalDate } from "../time/local-date";
import type { PayConfigRow, SettlementPeriodRow } from "./rows";

// A tenant's pay rules are versioned by effective date (pay_configs, one row per version). A
// version applies from the first pay period that STARTS on or after its effective_from, never
// from the middle of a period, so every settlement runs under exactly one version and the
// engine takes one PayConfig per call as before. week_start_dow is the same on every version, so
// the shape of the periods is known before a version is picked.

type Version = Pick<PayConfigRow, "effective_from" | "week_start_dow">;

// The versions oldest first, after checking each date is a real date, no two share one, and
// the week shape never changes.
export function sortVersions<T extends Version>(versions: readonly T[]): T[] {
  if (versions.length === 0) throw new ConfigError("no_pay_config");
  const sorted = [...versions].sort((a, b) => compareText(a.effective_from, b.effective_from));
  sorted.forEach((v, i) => {
    assertLocalDate(v.effective_from, "effective_from");
    if (i > 0 && v.effective_from === sorted[i - 1].effective_from) {
      throw new ConfigError("duplicate_effective_from");
    }
    if (v.week_start_dow !== sorted[0].week_start_dow) throw new ConfigError("week_start_changed");
  });
  return sorted;
}

// The version a pay period runs under: the newest one dated on or before the period's start.
// periodStart must be the first day of a period; before the first version there is none.
export function configFor<T extends Version>(versions: readonly T[], periodStart: LocalDate): T {
  const sorted = sortVersions(versions);
  assertLocalDate(periodStart, "periodStart");
  if (dayOfWeek(periodStart) !== sorted[0].week_start_dow) {
    throw new ConfigError("not_a_period_start");
  }
  const found = sorted.filter((v) => v.effective_from <= periodStart).pop();
  if (!found) throw new ConfigError("no_config_for_period");
  return found;
}

// The first period a version runs under: the first period that starts on or after its date, as
// configFor picks it. Null when a later version dated on or before that start replaces it first,
// so it never runs. A version dated mid-period shows the next period start, never its own date.
export function firstPeriodOf<T extends Version & { id: string }>(versions: readonly T[], version: T): LocalDate | null {
  const sorted = sortVersions(versions);
  const holding = periodContaining(assertLocalDate(version.effective_from, "effective_from"), sorted[0].week_start_dow);
  const start = holding.start === version.effective_from ? holding.start : addDays(holding.start, 7);
  return configFor(sorted, start).id === version.id ? start : null;
}

// The version for one day: the version of the period that holds it. An advance asked for on a
// day is judged under the version that week's settlement will use.
export function configForDay<T extends Version>(versions: readonly T[], day: LocalDate): T {
  const [first] = sortVersions(versions);
  const period = periodContaining(assertLocalDate(day, "day"), first.week_start_dow);
  return configFor(versions, period.start);
}

// The version the pay checks read: the newest open period's (the current week, where new records
// land, D-090); with no open period, the newest version. A sweep reads its own week's version
// instead (checkInputOf with the week's start, D-093), which may be the older open week's.
export function checkVersionOf<T extends Version>(
  versions: readonly T[],
  periods: readonly Pick<SettlementPeriodRow, "period_start" | "status">[],
): T {
  const open = periods.filter((p) => p.status === "open").sort((a, b) => compareText(a.period_start, b.period_start));
  if (open.length > 0) return configFor(versions, open[open.length - 1].period_start);
  return sortVersions(versions).pop()!;
}
