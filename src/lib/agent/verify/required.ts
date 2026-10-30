import { z } from "zod";

// What every pay sweep run must do, as fixed lists (design-agents-102 3.1 and 3.3), and the
// coverage figure a run records against them. Pure: no reads, no writes, no model.

// The steps a sweep run's checklist must list, in order. The second look (plan, then check each
// driver) is listed only when the run starts with room for it.
export type SweepStep = "find" | "plan" | "check" | "draft" | "audit";

export function requiredSweepSteps(secondLook: boolean): readonly SweepStep[] {
  return secondLook ? ["find", "plan", "check", "draft", "audit"] : ["find", "draft", "audit"];
}

// The checks the find phase must run over every driver of the open week: the engine's pay checks
// (the ones runAllChecks runs), the payment on the wrong invoice check, and the settlement
// exceptions. Agent code never imports the engine, so the names are written out here;
// src/lib/sweep/required-checks.test.ts holds them to the engine's CHECK_NAMES and runAllChecks.
export const SWEEP_ENGINE_CHECKS = [
  "duplicate_advance",
  "fuel_on_wrong_driver",
  "insurance_day_not_driven",
  "missing_reimbursement",
  "delivered_without_rate",
  "over_advance_limit",
  "advance_over_load_cap",
] as const;

export const SWEEP_REQUIRED_CHECKS = [...SWEEP_ENGINE_CHECKS, "payment_on_wrong_invoice", "settlement"] as const;
export type SweepCheck = (typeof SWEEP_REQUIRED_CHECKS)[number];

const count = () => z.number().int().nonnegative();

// sweep_runs.coverage, as stored and as the run page reads it. fanout is there only when the
// second opinion compared its checks.
export const sweepCoverageSchema = z.strictObject({
  v: z.literal(1),
  checks: z.strictObject({ required: count(), ran: count() }),
  drivers: z.strictObject({ total: count(), checked: count() }),
  pct: z.number().int().min(0).max(100),
  fanout: z.strictObject({ planned: count(), checked: count() }).optional(),
});
export type SweepCoverage = z.infer<typeof sweepCoverageSchema>;

// The find phase's coverage: how many of the required checks ran, over how many of the week's
// drivers. pct is ran x checked / required x total, rounded down; with no drivers at all it is
// the checks' share alone. Only a check named on the required list counts.
export function sweepCoverage(ran: ReadonlySet<string>, drivers: { total: number; checked: number }): SweepCoverage {
  const required = SWEEP_REQUIRED_CHECKS.length;
  const done = SWEEP_REQUIRED_CHECKS.filter((c) => ran.has(c)).length;
  const total = Math.max(0, Math.trunc(drivers.total));
  const checked = Math.min(total, Math.max(0, Math.trunc(drivers.checked)));
  const pct = total === 0 ? Math.floor((done * 100) / required) : Math.floor((done * checked * 100) / (required * total));
  return sweepCoverageSchema.parse({ v: 1, checks: { required, ran: done }, drivers: { total, checked }, pct });
}

// The second opinion's part: the drivers it planned a check for and the ones whose check came
// back, from the comparison's own counts.
export function fanoutCoverage(counts: { drivers_checked: number; drivers_unchecked: number }): NonNullable<SweepCoverage["fanout"]> {
  const checked = Math.max(0, Math.trunc(counts.drivers_checked));
  const planned = checked + Math.max(0, Math.trunc(counts.drivers_unchecked));
  return { planned, checked };
}

// The stored column, or null when it is missing or not this shape (a run that kept none).
export function parseSweepCoverage(raw: string | null): SweepCoverage | null {
  if (raw === null) return null;
  try {
    const parsed = sweepCoverageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
