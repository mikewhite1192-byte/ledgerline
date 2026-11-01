import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { sortVersions } from "../data/config-version";
import { readTable } from "../data/read";
import type { SettlementPeriodRow } from "../data/rows";
import type { Queryable } from "../db";
import { ConfigError } from "../rules-engine";
import { daysBetween, localDateOf, periodContaining, type LocalDate, type Period } from "../time/local-date";
import { tenantLock } from "./stored";

// The pay week roll (D-090): when the sweep starts for a carrier, the pay week holding today (the
// carrier's local date, in its week shape) is made sure to exist, inserted open when it does not.
// The week before stays open, untouched, until a person approves and pays it and the roll-up
// closes it (book.ts rollUpPeriod), so the sweep never closes a week. Only the week holding today
// is opened, never a gap week before it. No money field is read or written here.
//
// Dedupe key: UNIQUE (tenant_id, period_start) with ON CONFLICT DO NOTHING, under the per-tenant
// advisory lock pay_week_roll for the caller's transaction.

export type RollReason = "switched_off" | "week_exists" | "before_first_version" | "no_pay_config";

export type RollResult = { opened: boolean; periodStart: LocalDate | null; reason?: RollReason };

// Pure. The week to open: the week holding `today`, when no period row already starts that day
// and the week does not start before the first pay rules version. Null means nothing to do. A
// period that overlaps the week without starting on its first day also counts as holding it, so
// a week is never opened across one already there.
export function weekToOpen(args: {
  today: LocalDate;
  weekStartDow: number;
  firstEffectiveFrom: LocalDate;
  periods: readonly Pick<SettlementPeriodRow, "period_start">[];
}): Period | null {
  const week = periodContaining(args.today, args.weekStartDow);
  if (week.start < args.firstEffectiveFrom) return null;
  if (args.periods.some((p) => Math.abs(daysBetween(week.start, p.period_start)) < 7)) return null;
  return week;
}

// SQL, inside the caller's tenant transaction. Reads its own switch. Never throws for a carrier
// with no pay config (returns reason "no_pay_config"); a database error propagates and fails the
// caller's transaction (fail closed).
export async function rollPayWeek(q: Queryable, now: Date): Promise<RollResult> {
  if (!flags.payWeekRoll.enabled) return { opened: false, periodStart: null, reason: "switched_off" };
  await tenantLock(q, "pay_week_roll");
  const tz = await q.query<{ timezone: string }>("SELECT timezone FROM tenants WHERE id = current_tenant_id()");
  // Unknown is not zero: a carrier whose zone does not read opens nothing on a guessed day.
  if (!tz[0]?.timezone) throw new Error("pay week roll: the carrier's time zone did not read");
  const today = localDateOf(now.toISOString(), tz[0].timezone);
  let first: { week_start_dow: number; effective_from: string };
  try {
    [first] = sortVersions(await readTable(q, "pay_configs"));
  } catch (e) {
    if (e instanceof ConfigError) return { opened: false, periodStart: null, reason: "no_pay_config" };
    throw e;
  }
  const holding = periodContaining(today, first.week_start_dow);
  const week = weekToOpen({
    today,
    weekStartDow: first.week_start_dow,
    firstEffectiveFrom: first.effective_from,
    periods: await readTable(q, "settlement_periods"),
  });
  if (!week) {
    const reason = holding.start < first.effective_from ? "before_first_version" : "week_exists";
    return { opened: false, periodStart: null, reason };
  }
  const inserted = await q.execute(
    `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($3 AS date), 'open')
     ON CONFLICT (tenant_id, period_start) DO NOTHING`,
    [randomUUID(), week.start, week.end],
  );
  const back = await q.query<{ id: string }>(
    `SELECT id FROM settlement_periods
      WHERE tenant_id = current_tenant_id() AND period_start = CAST($1 AS date)`,
    [week.start],
  );
  if (back.length !== 1) throw new Error("pay week roll: the opened week did not read back");
  // Zero rows inserted is the conflict: another start opened the week first.
  if (inserted !== 1) return { opened: false, periodStart: week.start, reason: "week_exists" };
  console.info(`pay week ${week.start} opened by the sweep`);
  return { opened: true, periodStart: week.start };
}
