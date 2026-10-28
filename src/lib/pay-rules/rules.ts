import type { PayConfigKnobs } from "../data/rows";
import { formatCents } from "../format/money";
import { INSURANCE_APPLIES_TO, PERCENT_BASES } from "../rules-engine";

// The pay rules a person may change by talking: 13 of the per-tenant knobs of one pay_configs
// version. Each one names its column, its unit, the range a sentence may set and whether the
// settlement math reads it (so a change has a weekly impact) or only the advance check does.
// week_start_dow is not a rule: the versions refuse a change of week shape, and per-driver rates
// and deduction schedules are a person's records, not the carrier's rules. The per-load advance
// cap (advance_per_load_bps_of_pay) is not one either, so the Pay rules page does not list it.
// Escrow per week is refused while a driver's escrow schedule runs (change.ts). Pure.

export const RULE_KEYS = [
  "insurance_per_day_cents",
  "insurance_applies_to",
  "escrow_target_cents",
  "escrow_per_settlement_cents",
  "net_pay_floor_cents",
  "advance_recovery_cap_cents",
  "advance_fee_cents",
  "advance_limit_default_cents",
  "advance_max_bps_of_earned",
  "advance_min_cents",
  "empty_miles_paid_bps",
  "accessorial_driver_share_bps",
  "percent_base",
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

export type RuleUnit = "cents_per_day" | "cents_per_settlement" | "cents" | "bps" | "enum";

export type RuleSpec = {
  key: RuleKey;
  column: Exclude<keyof PayConfigKnobs, "week_start_dow">;
  // Plain words for the screen and the questions back.
  label: string;
  unit: RuleUnit;
  // Cents or basis points bounds a sentence may set; enums list their values instead.
  min: number;
  max: number;
  values?: readonly string[];
  // Only the advance cap may be "no cap".
  nullable: boolean;
  // Whether settleDriver reads it (impact shown) or only advanceEligibility does (impact 0).
  affects: "settlement" | "advances";
  // Hover help: what the rule means, for an office clerk who has never seen it.
  help: string;
};

export type RuleValue = number | string | null;

// Why a value cannot be set. Categories only; words.ts holds the sentences.
export class RuleError extends Error {
  constructor(readonly category: "bad_value" | "value_out_of_range") {
    super(category);
    this.name = "RuleError";
  }
}

const PER_DAY = { unit: "cents_per_day", min: 0, max: 50_000 } as const;
const PER_WEEK = { unit: "cents_per_settlement", min: 0, max: 100_000 } as const;
const CENTS = { unit: "cents", min: 0, max: 1_000_000 } as const;
const BPS = { unit: "bps", min: 0, max: 10_000 } as const;

const spec = (s: Omit<RuleSpec, "nullable"> & { nullable?: boolean }): RuleSpec => ({
  nullable: false,
  ...s,
});

export const RULES: Readonly<Record<RuleKey, RuleSpec>> = {
  insurance_per_day_cents: spec({
    key: "insurance_per_day_cents",
    column: "insurance_per_day_cents",
    label: "Insurance per day",
    ...PER_DAY,
    affects: "settlement",
    help: "Taken from pay for each insured day: each day the driver drove that week.",
  }),
  insurance_applies_to: spec({
    key: "insurance_applies_to",
    column: "insurance_applies_to",
    label: "Who pays insurance",
    unit: "enum",
    min: 0,
    max: 0,
    values: INSURANCE_APPLIES_TO,
    affects: "settlement",
    help: "Owner-operators only, or every driver. An owner-operator drives their own truck under the carrier's authority.",
  }),
  escrow_target_cents: spec({
    key: "escrow_target_cents",
    column: "escrow_target_cents",
    label: "Escrow target",
    ...CENTS,
    affects: "settlement",
    help: "Escrow is money held back from pay as a deposit. It stops growing once a driver holds this much.",
  }),
  escrow_per_settlement_cents: spec({
    key: "escrow_per_settlement_cents",
    column: "escrow_per_settlement_cents",
    label: "Escrow per week",
    ...PER_WEEK,
    affects: "settlement",
    help: "Held back from each week's pay into escrow until the driver reaches the escrow target.",
  }),
  net_pay_floor_cents: spec({
    key: "net_pay_floor_cents",
    column: "net_pay_floor_cents",
    label: "Net pay floor",
    ...CENTS,
    affects: "settlement",
    help: "The least a driver takes home in a week before escrow or advance repayments are taken.",
  }),
  advance_recovery_cap_cents: spec({
    key: "advance_recovery_cap_cents",
    column: "advance_recovery_cap_cents",
    label: "Advance cap",
    ...CENTS,
    nullable: true,
    affects: "settlement",
    help: "The most of an advance taken back from one week's pay. No cap takes back all that is owed, above the net pay floor.",
  }),
  advance_fee_cents: spec({
    key: "advance_fee_cents",
    column: "advance_fee_cents",
    label: "Advance fee",
    ...CENTS,
    affects: "advances",
    help: "Charged on each advance a driver takes.",
  }),
  advance_limit_default_cents: spec({
    key: "advance_limit_default_cents",
    column: "advance_limit_default_cents",
    label: "Advance limit",
    ...CENTS,
    affects: "advances",
    help: "The most a driver may owe in advances at once, unless the driver has a limit of their own.",
  }),
  advance_max_bps_of_earned: spec({
    key: "advance_max_bps_of_earned",
    column: "advance_max_bps_of_earned",
    label: "Share of pay an advance may take",
    ...BPS,
    affects: "advances",
    help: "An advance may be at most this share of what the driver has earned and not yet been paid. Shown as a percentage (basis points: 100 is 1%).",
  }),
  advance_min_cents: spec({
    key: "advance_min_cents",
    column: "advance_min_cents",
    label: "Smallest advance",
    ...CENTS,
    affects: "advances",
    help: "The smallest advance a driver may ask for.",
  }),
  empty_miles_paid_bps: spec({
    key: "empty_miles_paid_bps",
    column: "empty_miles_paid_bps",
    label: "Empty miles paid",
    ...BPS,
    affects: "settlement",
    help: "The share of empty miles (driving with no load) paid to per-mile drivers. Shown as a percentage (basis points: 100 is 1%).",
  }),
  accessorial_driver_share_bps: spec({
    key: "accessorial_driver_share_bps",
    column: "accessorial_driver_share_bps",
    label: "Drivers' share of extra charges",
    ...BPS,
    affects: "settlement",
    help: "Extra charges are charges on a load beyond the haul itself, like detention, layover or an extra stop. This is the share paid to the driver, as a percentage (basis points: 100 is 1%).",
  }),
  percent_base: spec({
    key: "percent_base",
    column: "percent_base",
    label: "What the percentage is paid on",
    unit: "enum",
    min: 0,
    max: 0,
    values: PERCENT_BASES,
    affects: "settlement",
    help: "For drivers paid a percentage: 35% of linehaul pays 35% of the load's linehaul, the base rate for the miles, before fuel surcharge and extra charges.",
  }),
};

export function isRuleKey(value: unknown): value is RuleKey {
  return typeof value === "string" && (RULE_KEYS as readonly string[]).includes(value);
}

// The value a sentence asked for, checked against the rule: an integer in range, one of the
// enum's values, or null where the rule allows "no cap". Throws RuleError.
export function parseValue(s: RuleSpec, raw: unknown): RuleValue {
  if (raw === null) {
    if (s.nullable) return null;
    throw new RuleError("bad_value");
  }
  if (s.unit === "enum") {
    if (typeof raw === "string" && (s.values ?? []).includes(raw)) return raw;
    throw new RuleError("bad_value");
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) throw new RuleError("bad_value");
  if (raw < s.min || raw > s.max) throw new RuleError("value_out_of_range");
  return raw;
}

const ENUM_WORDS: Readonly<Record<string, string>> = {
  owner_operator: "owner-operators",
  all: "all drivers",
  linehaul: "linehaul",
  linehaul_fsc: "linehaul and fuel surcharge",
  linehaul_fsc_accessorials: "linehaul, fuel surcharge and extra charges",
};

// Basis points as a percentage: 3500 is "35%", 3550 "35.5%", 1 "0.01%".
export function percentOf(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  if (rest === 0) return `${whole}%`;
  return `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}%`;
}

// The value alone: "$12.00", "35%", "owner-operators", "no cap".
export function shortValue(s: RuleSpec, value: RuleValue): string {
  if (value === null) return "no cap";
  if (typeof value === "string") return ENUM_WORDS[value] ?? value.replace(/_/g, " ");
  if (s.unit === "bps") return percentOf(value);
  return formatCents(value);
}

// The value with its unit: "$12.00 per insured day", "$100.00 per week", "35%".
export function formatValue(s: RuleSpec, value: RuleValue): string {
  const short = shortValue(s, value);
  if (value === null || typeof value === "string") return short;
  if (s.unit === "cents_per_day") return `${short} per insured day`;
  if (s.unit === "cents_per_settlement") return `${short} per week`;
  return short;
}

// The unit words a title ends with: "per day", "per week", or nothing.
export function unitSuffix(s: RuleSpec): string {
  if (s.unit === "cents_per_day") return " per day";
  if (s.unit === "cents_per_settlement") return " per week";
  return "";
}

// The value as stored in pay_rule_changes: "1200", "null", "all".
export function valueText(value: RuleValue): string {
  return value === null ? "null" : String(value);
}

// A copy of the version's knobs with one rule replaced. The caller runs the copy through the
// engine's own check (payConfigOf, then assertPayConfig).
export function applyRule(base: PayConfigKnobs, key: RuleKey, value: RuleValue): PayConfigKnobs {
  const s = RULES[key];
  return { ...base, [s.column]: value } as PayConfigKnobs;
}

// The rule's name on a card or a version's note: insurance charged to owner-operators only reads
// "Owner-operator insurance".
export function labelFor(key: RuleKey, appliesTo: string): string {
  if (key === "insurance_per_day_cents" && appliesTo === "owner_operator") {
    return "Owner-operator insurance";
  }
  return RULES[key].label;
}

// The value a version holds for a rule.
export function valueOf(knobs: PayConfigKnobs, key: RuleKey): RuleValue {
  return knobs[RULES[key].column];
}
