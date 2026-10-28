import { z } from "zod";
import type { Queryable } from "../db";
import { configFor, sortVersions } from "../data/config-version";
import { readEscrowLines, readTable, readTenant, type TenantSummary } from "../data/read";
import { payConfigOf, settlementInputOf } from "../data/records";
import type {
  PayConfigRow,
  SettlementLineRow,
  SettlementPeriodRow,
  SettlementRow,
  TenantRows,
} from "../data/rows";
import {
  activeSchedule,
  assertCents,
  assertPayConfig,
  cents,
  ConfigError,
  INSURANCE_APPLIES_TO,
  PERCENT_BASES,
  settleDriver,
  type Cents,
  type PayConfig,
  type SettlementInput,
  type SourceRef,
} from "../rules-engine";
import {
  addDays,
  daysBetween,
  isLocalDate,
  localDateOf,
  periodContaining,
  type LocalDate,
} from "../time/local-date";
import { valueInText } from "./figures";
import { ruleImpact, type ImpactDriver, type RuleImpact } from "./impact";
import {
  applyRule,
  isRuleKey,
  labelFor,
  parseValue,
  RULE_KEYS,
  RuleError,
  RULES,
  valueOf,
  type RuleKey,
  type RuleUnit,
  type RuleValue,
} from "./rules";

// One pay rule change, checked and sized: what the preview tool, the propose tool's limit, the
// propose tool, the auditor's evidence and the approval's executor all compute, from the same
// rows, with the same engine. A change exists only when every one of these holds:
//   - the rule is one of the 13, and the value is in its range and in the person's sentence;
//   - it starts at a week start strictly after the week that holds today (a date inside a week
//     moves to the next week start, and the card says so), at most 366 days ahead;
//   - no saved version starts after it (that later version would undo it when it starts);
//   - it differs from the rule in force on that date;
//   - escrow per week changes only while no driver's escrow schedule runs in or after that week
//     (the engine takes each schedule's own amount, so the carrier's would change nothing);
//   - no approved or paid pay names the version it would edit or falls on or after its date;
//   - a version it would edit was made by a person, never by the seed.

export type RuleChangeArgs = { ruleKey: string; newValue: unknown; askedFrom: string };

export type RuleChangeRefusal =
  | "unknown_rule"
  | "bad_value"
  | "value_out_of_range"
  | "value_not_in_message"
  | "bad_date"
  | "effective_in_past"
  | "too_far_ahead"
  | "later_version"
  | "no_change"
  | "escrow_on_driver_schedules"
  | "locked_version"
  | "no_pay_config"
  | "week_shape";

export type RuleChange = {
  ruleKey: RuleKey;
  label: string;
  unit: RuleUnit;
  // Who pays insurance under the version changed, which names the insurance rule on the card.
  appliesTo: (typeof INSURANCE_APPLIES_TO)[number];
  baseVersionId: string;
  baseEffectiveFrom: LocalDate;
  oldValue: RuleValue;
  newValue: RuleValue;
  askedFrom: LocalDate;
  effectiveFrom: LocalDate;
  // The asked date fell inside a week, so the change starts with the next full week.
  snapped: boolean;
  applied: "new_version" | "edited_version";
  impact: RuleImpact;
  // The version changed, the week compared, and up to 8 of that week's settlements.
  sources: SourceRef[];
};

export type RuleChangeCheck = { ok: true; change: RuleChange } | { ok: false; reason: RuleChangeRefusal };

type DriverRows = Pick<
  TenantRows,
  | "pay_configs"
  | "drivers"
  | "loads"
  | "load_state_miles"
  | "load_accessorials"
  | "driver_days"
  | "pay_items"
  | "deduction_schedules"
  | "advances"
>;

export type RuleChangeRows = DriverRows & {
  tenant: TenantSummary;
  settlement_periods: SettlementPeriodRow[];
  settlements: SettlementRow[];
  // The escrow lines of the tenant's settlements (the reader loads no other kind; any other line
  // here is ignored). Each holds the escrow balance its week started from.
  settlement_lines: SettlementLineRow[];
};

// The rows a change is checked and sized from, for the current tenant. Read-only; the executor
// takes its locks before it calls this.
export async function readRuleChangeRows(q: Queryable): Promise<RuleChangeRows> {
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant is set");
  return {
    tenant,
    pay_configs: await readTable(q, "pay_configs"),
    settlement_periods: await readTable(q, "settlement_periods"),
    settlements: await readTable(q, "settlements"),
    settlement_lines: await readEscrowLines(q),
    drivers: await readTable(q, "drivers"),
    loads: await readTable(q, "loads"),
    load_state_miles: await readTable(q, "load_state_miles"),
    load_accessorials: await readTable(q, "load_accessorials"),
    driver_days: await readTable(q, "driver_days"),
    pay_items: await readTable(q, "pay_items"),
    deduction_schedules: await readTable(q, "deduction_schedules"),
    advances: await readTable(q, "advances"),
  };
}

const FROZEN = new Set(["approved", "paid"]);
// Versions a person made: in the app, or by approving an earlier change. Never the seed's.
const PERSON_MADE: ReadonlySet<PayConfigRow["source"]> = new Set(["ui", "proposal"]);
export const MAX_DAYS_AHEAD = 366;
const MAX_SOURCE_SETTLEMENTS = 8;

// Whose sentence the value must be found in: the person's text from the turn (null outside a
// turn, which refuses), or "skip" for the executor and the auditor, which re-check a change whose
// sentence was checked when it was proposed.
export type Grounding = { text: string | null } | "skip";

function configRefusal(error: unknown): RuleChangeRefusal {
  if (!(error instanceof ConfigError)) throw error;
  return error.message === "no_pay_config" || error.message === "no_config_for_period"
    ? "no_pay_config"
    : "week_shape";
}

// The escrow a frozen week ran from, from that week's own stored records only. The driver's
// balance now already holds what that week (and any week after it) took, so it is never used.
// The engine stores the balance a week started from on the week's escrow line
// (meta.balanceBeforeCents), so both runs start from it. A line without a whole stored balance, or
// two escrow lines on one settlement, throws (unknown).
//
// A week that took no escrow stored no balance, so it is known only as far as the week's own run
// bounds it: under the week's own version it took none, so it started at or above that version's
// target, unless no balance at all would have let it take any (the net pay floor left no room, the
// week fell below zero). Both runs start from the lowest such balance. Escrow taken only falls as
// the balance rises, so when neither run takes any escrow from that balance, neither takes any from
// the balance the week really started from, and the figure is exact. When either run would take
// some (a raised escrow target, or a change that leaves room above the floor), what it takes
// depends on the balance nobody stored: the figure is unknown, never zero, and it throws.
// `runs` holds the two configs the impact compares; none (a rule the settlement math does not
// read) skips the runs.
function escrowAsPaid(
  settlementId: string,
  lines: readonly SettlementLineRow[],
  input: SettlementInput,
  runs: readonly PayConfig[],
): SettlementInput {
  const own = lines.filter((l) => l.settlement_id === settlementId && l.kind === "escrow");
  if (own.length > 1) throw new Error("a settlement has more than one escrow line");
  if (own.length === 1) {
    return {
      ...input,
      escrowBalanceCents: assertCents(own[0].meta?.balanceBeforeCents, "the escrow line's starting balance"),
    };
  }
  if (runs.length === 0) return { ...input, escrowBalanceCents: cents(0) };
  const lowest = lowestStartingBalance(input);
  for (const config of runs) {
    if (settleDriver({ ...input, config, escrowBalanceCents: lowest }).escrowDeltaCents !== 0) {
      throw new Error("a week that took no escrow could take some under this change; its starting balance is unknown");
    }
  }
  return { ...input, escrowBalanceCents: lowest };
}

// The lowest escrow balance a week that took no escrow could have started from, under the week's
// own version (input.config): 0 when the week takes none even from 0, else the target its escrow
// schedule stops at (below it, the week would have taken some).
function lowestStartingBalance(input: SettlementInput): Cents {
  if (settleDriver({ ...input, escrowBalanceCents: cents(0) }).escrowDeltaCents === 0) return cents(0);
  const schedule = activeSchedule(input.schedules, "escrow", input.period);
  if (!schedule) throw new Error("escrow was taken with no escrow schedule");
  return schedule.targetCents ?? input.config.escrowTargetCents;
}

// The newest frozen week and its frozen settlements, each with the engine's input for it.
function comparedWeek(
  rows: RuleChangeRows,
  runs: readonly PayConfig[],
): {
  period: SettlementPeriodRow | null;
  drivers: ImpactDriver[];
} {
  const period =
    [...rows.settlement_periods]
      .filter((p) => FROZEN.has(p.status))
      .sort((a, b) => (a.period_start < b.period_start ? 1 : a.period_start > b.period_start ? -1 : 0))[0] ??
    null;
  if (!period) return { period: null, drivers: [] };
  const span = { start: period.period_start, end: period.period_end };
  const drivers = rows.settlements
    .filter((s) => s.period_id === period.id && FROZEN.has(s.status))
    .map((s) => {
      const driver = rows.drivers.find((d) => d.id === s.driver_id);
      if (!driver) throw new Error("a settlement names no driver");
      return {
        driverId: driver.id,
        code: driver.code,
        workerType: driver.worker_type,
        settlementId: s.id,
        input: escrowAsPaid(s.id, rows.settlement_lines, settlementInputOf(rows, driver.id, span), runs),
      };
    })
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { period, drivers };
}

// Throws on rows the engine refuses (a malformed load, a settlement naming no driver); every
// caller treats a throw as unknown, never as a yes.
export function ruleChangeOf(
  rows: RuleChangeRows,
  args: RuleChangeArgs,
  grounding: Grounding,
  now: Date,
): RuleChangeCheck {
  const no = (reason: RuleChangeRefusal): RuleChangeCheck => ({ ok: false, reason });
  // 1. The rule.
  if (!isRuleKey(args.ruleKey)) return no("unknown_rule");
  const spec = RULES[args.ruleKey];
  // 2. The value.
  let newValue: RuleValue;
  try {
    newValue = parseValue(spec, args.newValue);
  } catch (error) {
    if (error instanceof RuleError) return no(error.category);
    throw error;
  }
  // 3. The value is in the person's own sentence.
  if (grounding !== "skip") {
    if (grounding.text === null || !valueInText(spec, newValue, grounding.text)) {
      return no("value_not_in_message");
    }
  }
  // 4. The date.
  if (!isLocalDate(args.askedFrom)) return no("bad_date");
  const askedFrom = args.askedFrom;
  // 5. The week it starts, in the carrier's zone and week shape.
  let versions: PayConfigRow[];
  try {
    versions = sortVersions(rows.pay_configs);
  } catch (error) {
    return no(configRefusal(error));
  }
  const dow = versions[0].week_start_dow;
  const today = localDateOf(now.toISOString(), rows.tenant.timezone);
  const thisWeek = periodContaining(today, dow);
  const asked = periodContaining(askedFrom, dow);
  const snapped = askedFrom !== asked.start;
  const effectiveFrom = snapped ? addDays(asked.start, 7) : asked.start;
  if (effectiveFrom <= thisWeek.start) return no("effective_in_past");
  if (daysBetween(today, effectiveFrom) > MAX_DAYS_AHEAD) return no("too_far_ahead");
  if (versions.some((v) => v.effective_from > effectiveFrom)) return no("later_version");
  // 6. The version in force that week, and the rule's value in it.
  let base: PayConfigRow;
  try {
    base = configFor(versions, effectiveFrom);
  } catch (error) {
    return no(configRefusal(error));
  }
  const oldValue = valueOf(base, spec.key);
  if (oldValue === newValue) return no("no_change");
  // 7. Escrow per week reaches no pay while a driver's escrow schedule runs: the engine takes each
  //    schedule's own amount, and a schedule is a person's record, never edited here. Refused
  //    while any escrow schedule is active in or after the week the change starts.
  if (
    spec.key === "escrow_per_settlement_cents" &&
    rows.deduction_schedules.some((s) => s.kind === "escrow" && (s.active_to === null || s.active_to >= effectiveFrom))
  ) {
    return no("escrow_on_driver_schedules");
  }
  // 8. Edit the version that starts that week, or add one; never touch frozen pay. Only a version
  //    a person made is edited in place; a seeded one is locked.
  const applied = base.effective_from === effectiveFrom ? "edited_version" : "new_version";
  if (applied === "edited_version" && !PERSON_MADE.has(base.source)) return no("locked_version");
  const startOf = new Map(rows.settlement_periods.map((p) => [p.id, p.period_start]));
  const frozenPay = rows.settlements.filter((s) => FROZEN.has(s.status));
  const locked =
    (applied === "edited_version" && frozenPay.some((s) => s.pay_config_id === base.id)) ||
    frozenPay.some((s) => {
      const start = startOf.get(s.period_id);
      return start === undefined || start >= effectiveFrom;
    }) ||
    rows.settlement_periods.some((p) => FROZEN.has(p.status) && p.period_start >= effectiveFrom);
  if (locked) return no("locked_version");
  // 9. The engine's impact on the newest settled week.
  const baseConfig = payConfigOf(base);
  const candidate = assertPayConfig(payConfigOf(applyRule(base, spec.key, newValue)));
  const week = comparedWeek(rows, spec.affects === "settlement" ? [baseConfig, candidate] : []);
  const impact = ruleImpact(
    spec,
    week.period
      ? { id: week.period.id, start: week.period.period_start, end: week.period.period_end }
      : null,
    week.drivers,
    candidate,
    baseConfig,
  );
  const sources: SourceRef[] = [{ table: "pay_configs", id: base.id }];
  if (week.period) {
    sources.push({ table: "settlement_periods", id: week.period.id });
    for (const d of week.drivers.slice(0, MAX_SOURCE_SETTLEMENTS)) {
      sources.push({ table: "settlements", id: d.settlementId });
    }
  }
  return {
    ok: true,
    change: {
      ruleKey: spec.key,
      label: labelFor(spec.key, base.insurance_applies_to),
      unit: spec.unit,
      appliesTo: base.insurance_applies_to,
      baseVersionId: base.id,
      baseEffectiveFrom: base.effective_from,
      oldValue,
      newValue,
      askedFrom,
      effectiveFrom,
      snapped,
      applied,
      impact,
      sources,
    },
  };
}

// What a pay_rule_change proposal stores as its args: the rule, both values, the dates, the
// version and the engine's impact. Ids, integers, enums and dates only, never free text. The
// executor parses the stored args with this schema and compares every field with what the engine
// says at approval.
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const DATE = z.string().refine(isLocalDate);
const COUNT = z.int().min(0).max(1_000_000);
const SIGNED_CENTS = z.int().min(-999_999_999).max(999_999_999);
const VALUE = z.union([
  z.int().min(0).max(1_000_000),
  z.enum([...INSURANCE_APPLIES_TO, ...PERCENT_BASES]),
  z.null(),
]);
export const changeArgsSchema = z.strictObject({
  ruleKey: z.enum(RULE_KEYS),
  oldValue: VALUE,
  newValue: VALUE,
  askedFrom: DATE,
  effectiveFrom: DATE,
  snapped: z.boolean(),
  applied: z.enum(["new_version", "edited_version"]),
  baseVersionId: UUID,
  baseEffectiveFrom: DATE,
  appliesTo: z.enum(INSURANCE_APPLIES_TO),
  impact: z.strictObject({
    basis: z.enum(["settled_week", "no_settled_week", "advances_only"]),
    periodId: UUID.nullable(),
    periodStart: DATE.nullable(),
    periodEnd: DATE.nullable(),
    driversCompared: COUNT,
    driversChanged: COUNT,
    netDeltaCents: SIGNED_CENTS,
    ownerOperatorsOnly: z.boolean(),
    top: z
      .array(
        z.strictObject({
          driverId: UUID,
          code: z.string().regex(/^[A-Z0-9-]{2,20}$/),
          deltaCents: SIGNED_CENTS,
          settlementId: UUID,
        }),
      )
      .max(5),
  }),
});
export type ChangeArgs = z.infer<typeof changeArgsSchema>;

// A value as the args store it: parseValue already holds an enum rule to its own values, so a
// string outside them here is a defect, never a stored value.
const ENUM_VALUES: readonly string[] = [...INSURANCE_APPLIES_TO, ...PERCENT_BASES];
function argValue(value: RuleValue): ChangeArgs["newValue"] {
  if (typeof value === "string" && !ENUM_VALUES.includes(value)) throw new Error("a rule value is not one of its values");
  return value as ChangeArgs["newValue"];
}

export function changeArgsOf(change: RuleChange): ChangeArgs {
  const i = change.impact;
  return {
    ruleKey: change.ruleKey,
    oldValue: argValue(change.oldValue),
    newValue: argValue(change.newValue),
    askedFrom: change.askedFrom,
    effectiveFrom: change.effectiveFrom,
    snapped: change.snapped,
    applied: change.applied,
    baseVersionId: change.baseVersionId,
    baseEffectiveFrom: change.baseEffectiveFrom,
    appliesTo: change.appliesTo,
    impact: {
      basis: i.basis,
      periodId: i.periodId,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      driversCompared: i.driversCompared,
      driversChanged: i.driversChanged,
      netDeltaCents: i.netDeltaCents,
      ownerOperatorsOnly: i.ownerOperatorsOnly,
      top: i.top.map((t) => ({
        driverId: t.driverId,
        code: t.code,
        deltaCents: t.deltaCents,
        settlementId: t.settlementId,
      })),
    },
  };
}

// Whole values, every field, in any key order (jsonb stores keys in its own order).
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// The stored args say exactly what the engine says now.
export function changeMatches(args: unknown, change: RuleChange): boolean {
  const parsed = changeArgsSchema.safeParse(args);
  return parsed.success && same(parsed.data, changeArgsOf(change));
}
