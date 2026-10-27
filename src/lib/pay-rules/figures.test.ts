import { describe, expect, it } from "vitest";
import { figuresIn, valueInText } from "./figures";
import { RULES } from "./rules";

const money = (text: string) => [...figuresIn(text, "money")].sort((a, b) => a - b);
const bps = (text: string) => [...figuresIn(text, "bps")].sort((a, b) => a - b);

describe("the figures in a person's sentence", () => {
  it("reads dollars as cents", () => {
    expect(money("Starting Nov 2, owner-operator insurance goes to $12 a day")).toEqual([1200]);
    expect(money("insurance is $12.00 per day from 2026-11-02")).toEqual([1200]);
    expect(money("escrow target $2,500 from November 9th")).toEqual([250000]);
    expect(money("advance fee 5 dollars")).toEqual([500]);
    expect(money("advance fee 75 cents")).toEqual([75]);
    expect(money("insurance 12.5 starting 11/9")).toEqual([1250]);
  });

  it("never reads a date or a year as an amount", () => {
    expect(money("From Nov 9, escrow is $75 a week.")).toEqual([7500]);
    expect(money("from 9 November 2026 escrow is $75")).toEqual([7500]);
    expect(money("on 2026-11-09")).toEqual([]);
    expect(money("on 11/9/2026")).toEqual([]);
  });

  it("keeps percentages and money apart", () => {
    expect(money("empty miles at 35% from Nov 9")).toEqual([]);
    expect(bps("empty miles at 35% from Nov 9")).toEqual([3500]);
    expect(bps("empty miles at 35.5 percent")).toEqual([3550]);
    expect(bps("advance share 2500 bps")).toEqual([2500]);
    expect(bps("insurance $12 a day")).toEqual([]);
    // A bare number reads as a percentage for a share.
    expect(bps("empty miles paid 40 from Nov 9")).toEqual([4000]);
  });

  it("finds both figures when a sentence names two", () => {
    expect(money("insurance from $11 to $12 starting Nov 2")).toEqual([1100, 1200]);
  });

  it("does not read numbers spelled in words", () => {
    expect(money("insurance goes to twelve dollars a day")).toEqual([]);
    expect(valueInText(RULES.insurance_per_day_cents, 1200, "insurance goes to twelve dollars a day")).toBe(false);
  });
});

describe("whether the sentence holds the value", () => {
  const text = "Starting Nov 2, owner-operator insurance goes to $12 a day";

  it("compares whole values, never part of one", () => {
    expect(valueInText(RULES.insurance_per_day_cents, 1200, text)).toBe(true);
    expect(valueInText(RULES.insurance_per_day_cents, 120, text)).toBe(false);
    expect(valueInText(RULES.insurance_per_day_cents, 200, text)).toBe(false);
    // The 2 of the date is not an amount.
    expect(valueInText(RULES.insurance_per_day_cents, 200, "from Nov 2 insurance is $12")).toBe(false);
  });

  it("names enum values and no cap by their words", () => {
    expect(valueInText(RULES.insurance_applies_to, "all", "from Nov 9 every driver pays insurance")).toBe(true);
    expect(valueInText(RULES.insurance_applies_to, "all", "from Nov 9 insurance stays the same")).toBe(false);
    expect(valueInText(RULES.insurance_applies_to, "owner_operator", "only owner operators pay insurance")).toBe(true);
    expect(valueInText(RULES.advance_recovery_cap_cents, null, "advance cap: no cap from Nov 9")).toBe(true);
    expect(valueInText(RULES.advance_recovery_cap_cents, null, "advance cap goes away")).toBe(false);
    expect(valueInText(RULES.escrow_target_cents, null, "no cap")).toBe(false);
  });

  it("tells the percentage bases apart", () => {
    const pb = RULES.percent_base;
    expect(valueInText(pb, "linehaul_fsc", "percentage on linehaul plus fuel surcharge from Nov 9")).toBe(true);
    expect(valueInText(pb, "linehaul", "percentage on linehaul plus fuel surcharge from Nov 9")).toBe(false);
    expect(valueInText(pb, "linehaul", "percentage on linehaul only from Nov 9")).toBe(true);
    expect(valueInText(pb, "linehaul_fsc_accessorials", "pay on linehaul, fuel and accessorials")).toBe(true);
    expect(valueInText(pb, "linehaul_fsc_accessorials", "pay on linehaul, fuel surcharge and extra charges")).toBe(true);
    expect(valueInText(pb, "linehaul_fsc", "pay on linehaul, fuel surcharge and extra charges")).toBe(false);
  });

  it("reads a share in basis points", () => {
    expect(valueInText(RULES.empty_miles_paid_bps, 3500, "empty miles at 35% from Nov 9")).toBe(true);
    expect(valueInText(RULES.empty_miles_paid_bps, 35, "empty miles at 35% from Nov 9")).toBe(false);
  });
});
