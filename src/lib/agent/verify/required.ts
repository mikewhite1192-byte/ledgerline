import { z } from "zod";

// What every pay sweep run and every proposal must do, as fixed lists (design-agents-102 3.1 and
// 3.3), and the coverage figures recorded against them. Pure: no reads, no writes, no model.

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

// What every proposal must pass before it is saved (design-agents-102 3.1), in the order the checks
// run: the gateway's form, record and limit steps, then, in the loop before the insert, the case
// record and the engine's own recompute. Every propose_* kind moves money or sits beside it, so all
// five are required.
export const PROPOSAL_REQUIRED_CHECKS = [
  "schema",
  "records_exist",
  "engine_limit",
  "sources_in_record",
  "engine_recompute",
] as const;
export type ProposalCheck = (typeof PROPOSAL_REQUIRED_CHECKS)[number];

// The checks in plain words, as a person reads them.
export const PROPOSAL_CHECK_WORDS: Readonly<Record<ProposalCheck, string>> = {
  schema: "In the right form",
  records_exist: "Every record named exists",
  engine_limit: "Inside what the pay rules allow",
  sources_in_record: "Every citation is from the case record",
  engine_recompute: "The pay rules recomputed the same number",
};

// One try's result: the checks that failed and the ones that passed before it stopped. A check
// after the one that failed never ran, so it is in neither list.
export type ProposalVerification = { failed: ProposalCheck[]; passed: ProposalCheck[] };

const upTo = (n: number): ProposalCheck[] => PROPOSAL_REQUIRED_CHECKS.slice(0, n);

// The gateway's limit step refuses with one of these; a screen refuses after the limit passed.
const LIMIT_REASONS: ReadonlySet<string> = new Set(["amount_over_limit", "engine_refused", "limit_unavailable", "budget"]);
const SCREEN_REASONS: ReadonlySet<string> = new Set(["screen_flagged", "screen_error"]);

// A gateway refusal after the schema passed, by the step it stopped at (the gateway's order: ids,
// then the limit, then the screen). A screen is not a proposal check, so it fails none of them. A
// reason this does not know claims only the schema, which the call passed to be counted at all.
export function gatewayVerification(reason: string): ProposalVerification {
  if (reason === "unknown_record") return { failed: ["records_exist"], passed: upTo(1) };
  if (LIMIT_REASONS.has(reason)) return { failed: ["engine_limit"], passed: upTo(2) };
  if (SCREEN_REASONS.has(reason)) return { failed: [], passed: upTo(3) };
  return { failed: [], passed: upTo(1) };
}

// The loop's refusals before the insert, and an accepted card. A kind the engine never compares
// passes without engine_recompute: it did not run, so it is not claimed.
export type PersistRefusal = "citation_not_in_record" | "engine_mismatch" | "limit_unavailable";
export function persistVerification(refusal: PersistRefusal | null, recomputed: boolean): ProposalVerification {
  if (refusal === "citation_not_in_record") return { failed: ["sources_in_record"], passed: upTo(3) };
  if (refusal !== null) return { failed: ["engine_recompute"], passed: upTo(4) };
  return { failed: [], passed: recomputed ? upTo(5) : upTo(4) };
}

export type ProposalCoverage = { required: number; passed: number; pct: number };

// How many of the required checks a card passed ("5 of 5 checks passed (100%)"). Only a name on
// the list counts, each once; pct is rounded down.
export function coverageOf(passed: Iterable<string>): ProposalCoverage {
  const seen = new Set(passed);
  const required = PROPOSAL_REQUIRED_CHECKS.length;
  const n = PROPOSAL_REQUIRED_CHECKS.filter((c) => seen.has(c)).length;
  return { required, passed: n, pct: Math.floor((n * 100) / required) };
}
