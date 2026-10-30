import { configFor, sortVersions } from "../data/config-version";
import { payConfigOf } from "../data/records";
import type {
  DeductionScheduleRow,
  PayConfigKnobs,
  PayConfigRow,
  SettlementPeriodRow,
  SettlementRow,
} from "../data/rows";
import { MAX_DAYS_AHEAD } from "../pay-rules/change";
import { applyRule, parseValue, RuleError, RULE_KEYS, RULES, valueOf, type RuleKey, type RuleValue } from "../pay-rules/rules";
import { assertPayConfig, ConfigError } from "../rules-engine";
import { addDays, daysBetween, isLocalDate, localDateOf, periodContaining, type LocalDate } from "../time/local-date";
import type { FieldState } from "./cite";

// Where a version made from a policy goes, and what it changes: the one plan the run proposes, the
// approval's precheck and executor check, and the auditor's engine reads, from the same rows. The
// version always starts at a week start after the week that holds today, at most 366 days ahead,
// after every saved version, and no approved or paid pay falls on or after it. It is always a new
// version (never an edit of one in place) copied from the version in force before it. Pure.

export type PlanRows = {
  timezone: string;
  pay_configs: PayConfigRow[];
  settlement_periods: SettlementPeriodRow[];
  settlements: SettlementRow[];
  deduction_schedules: DeductionScheduleRow[];
};

export type PlacementRefusal =
  | "no_pay_config"
  | "week_shape"
  | "effective_in_past"
  | "too_far_ahead"
  | "later_version"
  | "stale"
  | "locked_version";

export type PlanRefusal = PlacementRefusal | "needs_choice" | "bad_edit" | "bad_value" | "no_change";

const FROZEN = new Set(["approved", "paid"]);

function versionsOf(rows: PlanRows): PayConfigRow[] | PlacementRefusal {
  if (rows.pay_configs.length === 0) return "no_pay_config";
  try {
    return sortVersions(rows.pay_configs);
  } catch (error) {
    if (error instanceof ConfigError) return error.message === "no_pay_config" ? "no_pay_config" : "week_shape";
    throw error;
  }
}

function lockedFrom(rows: PlanRows, effectiveFrom: LocalDate): boolean {
  const startOf = new Map(rows.settlement_periods.map((p) => [p.id, p.period_start]));
  return (
    rows.settlements.some((s) => {
      if (!FROZEN.has(s.status)) return false;
      const start = startOf.get(s.period_id);
      return start === undefined || start >= effectiveFrom;
    }) || rows.settlement_periods.some((p) => FROZEN.has(p.status) && p.period_start >= effectiveFrom)
  );
}

export type Placement =
  | { ok: true; effectiveFrom: LocalDate; base: PayConfigRow; askedFrom: LocalDate; moved: boolean }
  | { ok: false; reason: PlacementRefusal };

// The start the run proposes: the document's own date when it is a week start still open (a date
// inside a week moves to the next week start), otherwise the next week after this one; and never
// before the week after the newest saved version. askedFrom is the document's date when the
// version starts from it, otherwise the day the card was made; either way on or before the start.
// moved: the document named a date and the version does not start on it.
export function chooseStart(rows: PlanRows, documentDate: LocalDate | null, now: Date): Placement {
  const versions = versionsOf(rows);
  if (typeof versions === "string") return { ok: false, reason: versions };
  const dow = versions[0].week_start_dow;
  const today = localDateOf(now.toISOString(), rows.timezone);
  const thisWeek = periodContaining(today, dow);
  const nextWeek = addDays(thisWeek.start, 7);
  let effectiveFrom = nextWeek;
  let askedFrom: LocalDate = today;
  let moved = documentDate !== null;
  if (documentDate !== null && isLocalDate(documentDate)) {
    const asked = periodContaining(documentDate, dow);
    const start = asked.start === documentDate ? documentDate : addDays(asked.start, 7);
    if (start > thisWeek.start) {
      effectiveFrom = start;
      askedFrom = documentDate;
      moved = start !== documentDate;
    }
  }
  const newest = versions[versions.length - 1].effective_from;
  if (newest >= effectiveFrom) {
    effectiveFrom = addDays(periodContaining(newest, dow).start, 7);
    moved = documentDate !== null;
  }
  const placed = checkStart(rows, effectiveFrom, null, now);
  if (!placed.ok) return placed;
  return { ok: true, effectiveFrom, base: placed.base, askedFrom, moved };
}

// The stored start, checked again as of now: still a week start after this week, at most 366 days
// ahead, after every saved version, its base still the version in force (when one is named), and
// no approved or paid pay on or after it.
export function checkStart(
  rows: PlanRows,
  effectiveFrom: LocalDate,
  baseVersionId: string | null,
  now: Date,
): { ok: true; base: PayConfigRow } | { ok: false; reason: PlacementRefusal } {
  const versions = versionsOf(rows);
  if (typeof versions === "string") return { ok: false, reason: versions };
  if (!isLocalDate(effectiveFrom)) return { ok: false, reason: "stale" };
  const dow = versions[0].week_start_dow;
  const today = localDateOf(now.toISOString(), rows.timezone);
  const thisWeek = periodContaining(today, dow);
  if (periodContaining(effectiveFrom, dow).start !== effectiveFrom) return { ok: false, reason: "stale" };
  if (effectiveFrom <= thisWeek.start) return { ok: false, reason: "effective_in_past" };
  if (daysBetween(today, effectiveFrom) > MAX_DAYS_AHEAD) return { ok: false, reason: "too_far_ahead" };
  if (versions.some((v) => v.effective_from >= effectiveFrom)) return { ok: false, reason: "later_version" };
  let base: PayConfigRow;
  try {
    base = configFor(versions, effectiveFrom);
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, reason: "no_pay_config" };
    throw error;
  }
  if (baseVersionId !== null && base.id !== baseVersionId) return { ok: false, reason: "stale" };
  if (lockedFrom(rows, effectiveFrom)) return { ok: false, reason: "locked_version" };
  return { ok: true, base };
}

// A stored value ("1050", "null", "owner_operator") read with the rule's own parser. Throws
// RuleError.
export function parseStoredValue(key: RuleKey, text: string): RuleValue {
  const raw: unknown = text === "null" ? null : /^\d{1,9}$/.test(text) ? Number(text) : text;
  return parseValue(RULES[key], raw);
}

export type Edits = Readonly<Record<string, string>>;
export type PlannedChange = { key: RuleKey; oldValue: RuleValue; newValue: RuleValue; edited: boolean };
export type FieldPlan = { value: string; state: FieldState };

export type VersionPlan =
  | { ok: true; changes: PlannedChange[]; adminRequired: boolean; knobs: PayConfigKnobs }
  | { ok: false; reason: Extract<PlanRefusal, "needs_choice" | "bad_edit" | "bad_value" | "no_change"> };

// Raising the advance limit or the most recovered a week, or lowering the net pay floor, moves
// cash sooner: only an admin approves a version that does (design 5.2). No cap is the highest cap.
export function needsAdmin(changes: readonly PlannedChange[]): boolean {
  const capRank = (v: RuleValue) => (v === null ? Number.MAX_SAFE_INTEGER : Number(v));
  return changes.some(
    (c) =>
      (c.key === "advance_limit_default_cents" && Number(c.newValue) > Number(c.oldValue)) ||
      (c.key === "advance_recovery_cap_cents" && capRank(c.newValue) > capRank(c.oldValue)) ||
      (c.key === "net_pay_floor_cents" && Number(c.newValue) < Number(c.oldValue)),
  );
}

// The version a policy's fields make from the base: a Found value, or a person's edit (which may
// replace any rule), set over the base; a rule Not in document keeps the base's value; a rule that
// Needs you must be edited. Every value goes through the rule's own parser, then the whole
// candidate through the engine's own check.
export function planVersion(base: PayConfigKnobs, fields: Readonly<Record<RuleKey, FieldPlan>>, edits: Edits): VersionPlan {
  for (const key of Object.keys(edits)) {
    if (!(RULE_KEYS as readonly string[]).includes(key)) return { ok: false, reason: "bad_edit" };
  }
  let knobs: PayConfigKnobs = base;
  const changes: PlannedChange[] = [];
  for (const key of RULE_KEYS) {
    const field = fields[key];
    const edit = Object.prototype.hasOwnProperty.call(edits, key) ? edits[key] : undefined;
    let value: RuleValue;
    const oldValue = valueOf(base, key);
    try {
      if (edit !== undefined) value = parseStoredValue(key, edit);
      else if (field.state === "found") value = parseStoredValue(key, field.value);
      else if (field.state === "needs_you") return { ok: false, reason: "needs_choice" };
      else value = oldValue;
    } catch (error) {
      if (error instanceof RuleError) return { ok: false, reason: edit !== undefined ? "bad_edit" : "bad_value" };
      throw error;
    }
    if (value === oldValue) continue;
    changes.push({ key, oldValue, newValue: value, edited: edit !== undefined });
    knobs = applyRule(knobs, key, value);
  }
  if (changes.length === 0) return { ok: false, reason: "no_change" };
  try {
    assertPayConfig(payConfigOf(knobs));
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, reason: "bad_value" };
    throw error;
  }
  return { ok: true, changes, adminRequired: needsAdmin(changes), knobs };
}

// A driver's escrow schedule that runs in or after the week: the engine takes its own amount, so
// the carrier's escrow per week reaches no pay while one runs. Shown on the card, never refused.
export function escrowOnSchedules(rows: PlanRows, effectiveFrom: LocalDate): boolean {
  return rows.deduction_schedules.some((s) => s.kind === "escrow" && (s.active_to === null || s.active_to >= effectiveFrom));
}
