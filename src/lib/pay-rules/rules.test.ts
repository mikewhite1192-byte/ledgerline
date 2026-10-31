import { describe, expect, it } from "vitest";
import { payConfigOf } from "../data/records";
import type { PayConfigKnobs } from "../data/rows";
import { assertPayConfig } from "../rules-engine";
import {
  applyRule,
  formatValue,
  isRuleKey,
  labelFor,
  parseValue,
  percentOf,
  RULE_KEYS,
  RuleError,
  RULES,
  shortValue,
  unitSuffix,
  valueOf,
  valueText,
} from "./rules";

const BASE: PayConfigKnobs = {
  week_start_dow: 1,
  percent_base: "linehaul",
  empty_miles_paid_bps: 0,
  accessorial_driver_share_bps: 10000,
  insurance_applies_to: "owner_operator",
  insurance_per_day_cents: 1100,
  escrow_target_cents: 200000,
  escrow_per_settlement_cents: 10000,
  net_pay_floor_cents: 30000,
  advance_recovery_cap_cents: null,
  advance_fee_cents: 0,
  advance_limit_default_cents: 50000,
  advance_max_bps_of_earned: 5000,
  advance_min_cents: 5000,
  advance_per_load_bps_of_pay: null,
  advance_unlock_stage: "delivered",
};

const categoryOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof RuleError ? error.category : "other";
  }
  return null;
};

describe("the pay rule registry", () => {
  it("lists the 13 knobs, each its own column, never the week shape", () => {
    expect(RULE_KEYS).toHaveLength(13);
    const columns = RULE_KEYS.map((k) => RULES[k].column);
    expect(new Set(columns).size).toBe(13);
    for (const k of RULE_KEYS) {
      expect(RULES[k].key).toBe(k);
      expect(Object.keys(BASE)).toContain(RULES[k].column);
    }
    expect(columns).not.toContain("week_start_dow");
    expect(isRuleKey("week_start_dow")).toBe(false);
    expect(isRuleKey("insurance_per_day_cents")).toBe(true);
    expect(isRuleKey(3)).toBe(false);
  });

  it("gives every rule plain words and hover help", () => {
    for (const k of RULE_KEYS) {
      expect(RULES[k].label.length).toBeGreaterThan(3);
      expect(RULES[k].help.length).toBeGreaterThan(10);
    }
  });

  it("keeps every applied value inside what the engine accepts", () => {
    const samples: Record<string, unknown[]> = {
      insurance_per_day_cents: [0, 1200, 50000],
      insurance_applies_to: ["owner_operator", "all"],
      escrow_target_cents: [0, 1_000_000],
      escrow_per_settlement_cents: [0, 7500, 100000],
      net_pay_floor_cents: [0, 25000],
      advance_recovery_cap_cents: [null, 0, 20000],
      advance_fee_cents: [0, 500],
      advance_limit_default_cents: [0, 75000],
      advance_max_bps_of_earned: [0, 10000],
      advance_min_cents: [0, 2500],
      empty_miles_paid_bps: [0, 5000, 10000],
      accessorial_driver_share_bps: [0, 10000],
      percent_base: ["linehaul", "linehaul_fsc", "linehaul_fsc_accessorials"],
    };
    for (const k of RULE_KEYS) {
      for (const raw of samples[k]) {
        const value = parseValue(RULES[k], raw);
        const next = applyRule(BASE, k, value);
        expect(valueOf(next, k)).toBe(value);
        expect(() => assertPayConfig(payConfigOf(next))).not.toThrow();
        // Only the one column moved.
        const moved = Object.keys(BASE).filter((c) => next[c as keyof PayConfigKnobs] !== BASE[c as keyof PayConfigKnobs]);
        expect(moved.every((c) => c === RULES[k].column)).toBe(true);
      }
    }
  });

  it("refuses values out of range, fractions, wrong types and enums it does not list", () => {
    expect(categoryOf(() => parseValue(RULES.insurance_per_day_cents, 50_001))).toBe("value_out_of_range");
    expect(categoryOf(() => parseValue(RULES.insurance_per_day_cents, -1))).toBe("value_out_of_range");
    expect(categoryOf(() => parseValue(RULES.empty_miles_paid_bps, 10_001))).toBe("value_out_of_range");
    expect(categoryOf(() => parseValue(RULES.escrow_per_settlement_cents, 100_001))).toBe("value_out_of_range");
    expect(categoryOf(() => parseValue(RULES.insurance_per_day_cents, 12.5))).toBe("bad_value");
    expect(categoryOf(() => parseValue(RULES.insurance_per_day_cents, "1200"))).toBe("bad_value");
    expect(categoryOf(() => parseValue(RULES.percent_base, "gross"))).toBe("bad_value");
    expect(categoryOf(() => parseValue(RULES.insurance_applies_to, 1))).toBe("bad_value");
  });

  it("allows no cap only on the advance cap", () => {
    expect(parseValue(RULES.advance_recovery_cap_cents, null)).toBeNull();
    for (const k of RULE_KEYS.filter((x) => x !== "advance_recovery_cap_cents")) {
      expect(RULES[k].nullable).toBe(false);
      expect(categoryOf(() => parseValue(RULES[k], null))).toBe("bad_value");
    }
  });

  it("says each value in plain words with its unit", () => {
    expect(formatValue(RULES.insurance_per_day_cents, 1200)).toBe("$12.00 per insured day");
    expect(formatValue(RULES.escrow_per_settlement_cents, 7500)).toBe("$75.00 per week");
    expect(formatValue(RULES.escrow_target_cents, 200000)).toBe("$2,000.00");
    expect(formatValue(RULES.empty_miles_paid_bps, 3500)).toBe("35%");
    expect(formatValue(RULES.advance_recovery_cap_cents, null)).toBe("no cap");
    expect(formatValue(RULES.insurance_applies_to, "owner_operator")).toBe("owner-operators");
    expect(formatValue(RULES.percent_base, "linehaul_fsc")).toBe("linehaul and fuel surcharge");
    expect(shortValue(RULES.insurance_per_day_cents, 1100)).toBe("$11.00");
    expect(unitSuffix(RULES.insurance_per_day_cents)).toBe(" per day");
    expect(unitSuffix(RULES.escrow_per_settlement_cents)).toBe(" per week");
    expect(unitSuffix(RULES.advance_fee_cents)).toBe("");
  });

  it("writes basis points as a percentage", () => {
    expect(percentOf(3500)).toBe("35%");
    expect(percentOf(3550)).toBe("35.5%");
    expect(percentOf(3505)).toBe("35.05%");
    expect(percentOf(1)).toBe("0.01%");
    expect(percentOf(10000)).toBe("100%");
    expect(percentOf(0)).toBe("0%");
  });

  it("stores values as text and names owner-operator insurance by who pays it", () => {
    expect(valueText(1200)).toBe("1200");
    expect(valueText(null)).toBe("null");
    expect(valueText("all")).toBe("all");
    expect(labelFor("insurance_per_day_cents", "owner_operator")).toBe("Owner-operator insurance");
    expect(labelFor("insurance_per_day_cents", "all")).toBe("Insurance per day");
    expect(labelFor("escrow_target_cents", "owner_operator")).toBe("Escrow target");
  });
});
