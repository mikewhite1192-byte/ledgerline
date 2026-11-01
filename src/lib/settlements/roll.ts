import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { sortVersions } from "../data/config-version";
import { readTable } from "../data/read";
import type { SettlementPeriodRow } from "../data/rows";
import type { Queryable } from "../db";
import { ConfigError } from "../rules-engine";
import { addDays, daysBetween, localDateOf, periodContaining, type LocalDate, type Period } from "../time/local-date";
import { tenantLock } from "./stored";

// The pay week roll (D-090): when the sweep starts for a carrier, the pay week holding today (the
// carrier's local date, in its week shape) is made sure to exist, inserted open when it does not.
// The week before stays open, untouched, until a person approves and pays it and the roll-up
// closes it (book.ts rollUpPeriod), so the sweep never closes a week. Weeks stay back to back:
// when no sweep started for a whole week (or a demo reset put the seeded weeks back), the roll
// opens each missing week from the one right after the newest period up to today's, so a load
// delivered or a shortfall carried into a skipped week still has a week to draft in. No money
// field is read or written here.
//
// Dedupe key: UNIQUE (tenant_id, period_start) with ON CONFLICT DO NOTHING, under the per-tenant
// advisory lock pay_week_roll for the caller's transaction.

export type RollReason = "switched_off" | "week_exists" | "before_first_version" | "no_pay_config" | "week_shape";

export type RollResult = { opened: boolean; periodStart: LocalDate | null; reason?: RollReason };

// The most weeks one start opens. A longer run of missing weeks is caught up, oldest first, over
// the starts after it, so the weeks stay back to back either way.
export const MAX_WEEKS_PER_ROLL = 8;

// Pure. The weeks to open, oldest first: every week from the one right after the newest period
// (any status) through the week holding `today`, or today's week alone when the carrier has no
// period. A week that starts before the first pay rules version is never opened, and a period that
// overlaps a week without starting on its first day also counts as holding it, so a week is never
// opened across one already there. Empty means nothing to do; a newest period at or after today's
// week opens nothing behind it.
export function weeksToOpen(args: {
  today: LocalDate;
  weekStartDow: number;
  firstEffectiveFrom: LocalDate;
  periods: readonly Pick<SettlementPeriodRow, "period_start">[];
}): Period[] {
  const current = periodContaining(args.today, args.weekStartDow);
  if (current.start < args.firstEffectiveFrom) return [];
  const newest = args.periods.reduce<LocalDate | null>((m, p) => (m === null || p.period_start > m ? p.period_start : m), null);
  let from = newest === null ? current.start : addDays(newest, 7);
  if (from < args.firstEffectiveFrom) from = args.firstEffectiveFrom;
  let week = periodContaining(from, args.weekStartDow);
  if (week.start < from) week = periodContaining(addDays(week.start, 7), args.weekStartDow);
  const weeks: Period[] = [];
  for (let i = 0; i < MAX_WEEKS_PER_ROLL && week.start <= current.start; i += 1) {
    const start = week.start;
    if (!args.periods.some((p) => Math.abs(daysBetween(start, p.period_start)) < 7)) weeks.push(week);
    week = periodContaining(addDays(week.start, 7), args.weekStartDow);
  }
  return weeks;
}

// SQL, inside the caller's tenant transaction. Reads its own switch. Never throws for a carrier
// with no pay config (reason "no_pay_config") or pay rules whose versions do not line up (reason
// "week_shape"); a database error propagates and fails the caller's transaction (fail closed).
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
    if (e instanceof ConfigError) {
      return { opened: false, periodStart: null, reason: e.message === "no_pay_config" ? "no_pay_config" : "week_shape" };
    }
    throw e;
  }
  const holding = periodContaining(today, first.week_start_dow);
  const weeks = weeksToOpen({
    today,
    weekStartDow: first.week_start_dow,
    firstEffectiveFrom: first.effective_from,
    periods: await readTable(q, "settlement_periods"),
  });
  if (weeks.length === 0) {
    const reason = holding.start < first.effective_from ? "before_first_version" : "week_exists";
    return { opened: false, periodStart: null, reason };
  }
  let opened = false;
  for (const week of weeks) {
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
    if (inserted === 1) {
      opened = true;
      console.info(`pay week ${week.start} opened by the sweep`);
    }
  }
  const newest = weeks[weeks.length - 1].start;
  return opened ? { opened: true, periodStart: newest } : { opened: false, periodStart: newest, reason: "week_exists" };
}
