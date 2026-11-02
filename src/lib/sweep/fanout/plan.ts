import { readTable } from "../../data/read";
import { checkInputOf, settlementInputOf } from "../../data/records";
import type { TenantRows } from "../../data/rows";
import type { Queryable } from "../../db";
import { FINDING_CATEGORIES, settleDriver } from "../../rules-engine";
import {
  BRIEF_MAX,
  MAX_FOCUS,
  PLAN_FORMAT,
  PlanAnswer,
  SUMMARY_MAX,
  parseJson,
  scrubFigures,
} from "./schemas";

// The ordering call (design 3.2): Muse Wonder ranks the week's drivers for the per-driver checks.
// The roster is the server's: who had any record this week, in the same rows the engine's find
// reads (checkInputOf, the function readCheckInput uses), so the two never disagree on who is in
// the week. The model sees driver ids, record counts and the engine's categories only: no names,
// no amounts. The plan orders, never excludes: a driver it leaves out is checked last.

export const SEE_THE_RECORDS = "see the records";

export type RosterRow = {
  driverId: string;
  code: string;
  // The engine's net pay for the week, for the server's own order only; never sent to a model.
  netCents: number | null;
  loads: number;
  payItems: number;
  advances: number;
  days: number;
  // This run's engine findings for the driver, by category.
  findings: Record<string, number>;
};

export type SkippedDriver = { driverId: string; reason: "over_limit" | "no_activity" };

export type Roster = { rows: RosterRow[]; skipped: SkippedDriver[]; payBases: string[] };

export type PlannedCheck = { driverId: string; priority: 1 | 2 | 3; focus: string[]; brief: string | null };

export type ValidPlan = { summary: string | null; order: PlannedCheck[]; skipped: SkippedDriver[] };

type Window = { start: string; end: string };

const inWindow = (day: string | null | undefined, w: Window) => typeof day === "string" && day >= w.start && day <= w.end;

type RosterRows = Pick<
  TenantRows,
  | "pay_configs"
  | "settlement_periods"
  | "drivers"
  | "loads"
  | "load_state_miles"
  | "load_accessorials"
  | "driver_days"
  | "fuel_purchases"
  | "pay_items"
  | "advances"
  | "deduction_schedules"
>;

async function readRosterRows(q: Queryable): Promise<RosterRows> {
  return {
    pay_configs: await readTable(q, "pay_configs"),
    settlement_periods: await readTable(q, "settlement_periods"),
    drivers: await readTable(q, "drivers"),
    loads: await readTable(q, "loads"),
    load_state_miles: await readTable(q, "load_state_miles"),
    load_accessorials: await readTable(q, "load_accessorials"),
    driver_days: await readTable(q, "driver_days"),
    fuel_purchases: await readTable(q, "fuel_purchases"),
    pay_items: await readTable(q, "pay_items"),
    advances: await readTable(q, "advances"),
    deduction_schedules: await readTable(q, "deduction_schedules"),
  };
}

// The week's roster: every driver with a load, pay item, advance or day in the week, or an engine
// finding in this run; by the engine's net pay, highest first (a net the engine cannot work out
// sorts last), then by code. Past maxDrivers the rest are skipped as over_limit.
export async function readRoster(q: Queryable, runId: string, window: Window, maxDrivers: number): Promise<Roster> {
  const rows = await readRosterRows(q);
  // Under the run's week's pay rules version, as the run's find reads it.
  const input = checkInputOf(rows, window.start);
  const found = await q.query<{ driver_id: string; category: string; n: number | string }>(
    `SELECT driver_id, category, COUNT(*) AS n FROM sweep_items
      WHERE seen_run_id = CAST($1 AS uuid) AND driver_id IS NOT NULL AND finding_key NOT LIKE 'fanout:%'
      GROUP BY driver_id, category`,
    [runId],
  );
  const findings = new Map<string, Record<string, number>>();
  for (const f of found) {
    const id = f.driver_id.toLowerCase();
    const byCategory = findings.get(id) ?? {};
    byCategory[f.category] = (byCategory[f.category] ?? 0) + Number(f.n);
    findings.set(id, byCategory);
  }
  const active: RosterRow[] = [];
  const skipped: SkippedDriver[] = [];
  const bases = new Map<string, string>();
  for (const d of input.drivers) {
    const id = d.id.toLowerCase();
    const row: RosterRow = {
      driverId: id,
      code: d.code,
      netCents: null,
      loads: input.loads.filter((l) => l.driverId === d.id && (inWindow(l.pickupOn, window) || inWindow(l.deliveredOn, window))).length,
      payItems: input.items.filter((i) => i.driverId === d.id && inWindow(i.itemDate, window)).length,
      advances: input.advances.filter((a) => a.driverId === d.id && inWindow(a.requestedOn, window)).length,
      days: input.days.filter((x) => x.driverId === d.id && inWindow(x.day, window)).length,
      findings: findings.get(id) ?? {},
    };
    const any = row.loads + row.payItems + row.advances + row.days + Object.keys(row.findings).length;
    if (any === 0) {
      skipped.push({ driverId: id, reason: "no_activity" });
      continue;
    }
    try {
      const net = settleDriver(settlementInputOf(rows, d.id, window)).netCents;
      row.netCents = Number.isSafeInteger(net) ? net : null;
    } catch {
      // The engine could not work out this driver's week: still checked, ordered last.
      row.netCents = null;
    }
    bases.set(id, d.payBasis);
    active.push(row);
  }
  active.sort((a, b) => {
    if (a.netCents !== b.netCents) {
      if (a.netCents === null) return 1;
      if (b.netCents === null) return -1;
      return b.netCents - a.netCents;
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : a.driverId < b.driverId ? -1 : 1;
  });
  const max = Math.max(0, maxDrivers);
  const kept = active.slice(0, max);
  for (const r of active.slice(max)) skipped.push({ driverId: r.driverId, reason: "over_limit" });
  const payBases = [...new Set(kept.map((r) => bases.get(r.driverId) ?? ""))].filter((b) => b !== "").sort();
  return { rows: kept, skipped, payBases };
}

// Every driver at priority 3 in roster order: the plan when the ordering call did not answer.
export function defaultOrder(roster: Roster): ValidPlan {
  return {
    summary: null,
    order: roster.rows.map((r) => ({ driverId: r.driverId, priority: 3, focus: [], brief: null })),
    skipped: roster.skipped,
  };
}

const FOCUS: ReadonlySet<string> = new Set(FINDING_CATEGORIES);

// The server's rules on the model's plan (design 3.2): ids whole-match the roster (an unknown one
// is dropped and counted), each driver once, a roster driver left out is appended at priority 3,
// skipped is the server's own list, focus only the engine's categories, and a summary or brief
// with a figure in it becomes "see the records". Null when the answer does not parse or orders
// nobody while the roster has drivers.
export function validatePlan(raw: string, roster: Roster): { plan: ValidPlan; unknown: number } | null {
  const parsed = PlanAnswer.safeParse(parseJson(raw));
  if (!parsed.success) return null;
  if (parsed.data.order.length === 0 && roster.rows.length > 0) return null;
  const known = new Set(roster.rows.map((r) => r.driverId));
  const seen = new Set<string>();
  const order: PlannedCheck[] = [];
  let unknown = 0;
  for (const o of parsed.data.order) {
    const id = o.driverId.toLowerCase();
    if (!known.has(id)) {
      unknown += 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const brief = scrubFigures(o.brief, SEE_THE_RECORDS, BRIEF_MAX);
    order.push({
      driverId: id,
      priority: o.priority,
      focus: [...new Set(o.focus.filter((f) => FOCUS.has(f)))].slice(0, MAX_FOCUS),
      brief: brief === "" ? null : brief,
    });
  }
  for (const r of roster.rows) {
    if (!seen.has(r.driverId)) order.push({ driverId: r.driverId, priority: 3, focus: [], brief: null });
  }
  const summary = scrubFigures(parsed.data.summary, SEE_THE_RECORDS, SUMMARY_MAX);
  return { plan: { summary: summary === "" ? null : summary, order, skipped: roster.skipped }, unknown };
}

export const PLAN_PROMPT =
  "You plan a second check of one trucking carrier's weekly driver pay. You get the week, the " +
  "pay bases in use, the finding categories, and a roster: each driver's id, counts of that " +
  "driver's records this week, and the categories the rules engine already found for them. Order " +
  "every roster driver for checking: priority 1 for the drivers most likely to have a pay problem " +
  "worth a second look, 3 for the least. For each, name up to four finding categories to look at " +
  "and write one short sentence of what to look at. Never state an amount or any figure. Put each " +
  "roster driver in order exactly once; skipped lists only the drivers given to you as skipped. " +
  "Answer as JSON.";

// The ordering call's user message: ids, counts and categories only.
export function planInput(roster: Roster, window: Window): string {
  return JSON.stringify({
    week: { start: window.start, end: window.end },
    payBases: roster.payBases,
    categories: FINDING_CATEGORIES,
    roster: roster.rows.map((r) => ({
      driverId: r.driverId,
      loads: r.loads,
      payItems: r.payItems,
      advances: r.advances,
      days: r.days,
      engineFound: r.findings,
    })),
    skipped: roster.skipped,
  });
}

export { PLAN_FORMAT };
