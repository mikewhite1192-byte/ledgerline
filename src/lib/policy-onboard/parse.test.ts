import { describe, expect, it } from "vitest";
import { amountsOf, candidatesFor, dateOf, minutesOf, normalize, percentsOf, rangeOf, valueFromText, weekdayOf } from "./parse";

// The one reader of numbers in a policy's words: integers only, each figure read from the text
// itself, units checked against the rule.

describe("normalize", () => {
  it("makes typographic quotes, dashes and spaces plain and folds whitespace", () => {
    expect(normalize("\u201cdriver\u2019s\u201d  pay \u2014 per\u00a0day\n")).toBe('"driver\'s" pay - per day');
  });
});

describe("amounts", () => {
  it("reads dollars to whole cents with what each is counted by", () => {
    expect(amountsOf("$10.50 for each calendar day").map((a) => [a.cents, a.tag])).toEqual([[1050, "day"]]);
    expect(amountsOf("$125 from each weekly settlement").map((a) => [a.cents, a.tag])).toEqual([[12500, "week"]]);
    expect(amountsOf("reaches $2,500").map((a) => [a.cents, a.tag])).toEqual([[250000, null]]);
    expect(amountsOf("$0.62 per loaded mile")[0].cents).toBe(62);
    expect(amountsOf("$10.5 a day")[0]).toMatchObject({ cents: 1050, tag: "day" });
    expect(amountsOf("125 dollars")[0].cents).toBe(12500);
  });

  it("reads a figure restated by the week as two amounts", () => {
    expect(amountsOf("$11.00 per day, billed as $77.00 per week").map((a) => [a.cents, a.tag])).toEqual([
      [1100, "day"],
      [7700, "week"],
    ]);
  });

  it("reads ranges low first, and none from one amount", () => {
    expect(rangeOf("a fee of $3 to $5")).toEqual([300, 500]);
    expect(rangeOf("between $5 and $3")).toEqual([300, 500]);
    expect(rangeOf("$3-$5")).toEqual([300, 500]);
    expect(rangeOf("a $3 fee")).toBeNull();
  });
});

describe("percents, weekdays, dates and minutes", () => {
  it("reads percentages and their words to basis points", () => {
    expect(percentsOf("74 percent of the linehaul")).toEqual([7400]);
    expect(percentsOf("12.5% and 3 per cent")).toEqual([1250, 300]);
    expect(percentsOf("at half the loaded rate")).toEqual([5000]);
    expect(percentsOf("three quarters")).toEqual([7500]);
  });

  it("reads the first weekday, a date in three forms, and minutes", () => {
    expect(weekdayOf("from Monday through Sunday")).toBe(1);
    expect(weekdayOf("no day here")).toBeNull();
    expect(dateOf("on November 2, 2026 and")).toBe("2026-11-02");
    expect(dateOf("on 12/06/2026")).toBe("2026-12-06");
    expect(dateOf("from 2026-12-06")).toBe("2026-12-06");
    expect(dateOf("February 30, 2026")).toBeNull();
    expect(minutesOf("two hours free")).toBe(120);
    expect(minutesOf("90 minutes free")).toBe(90);
  });
});

describe("candidates for a rule", () => {
  it("reads a per-day rule from daily amounts and checks a weekly one is 7 times it", () => {
    expect(candidatesFor("insurance_per_day_cents", "$11.00 per day, billed as $77.00 per week")).toEqual({
      values: [1100],
      range: null,
      weekMismatch: false,
    });
    expect(candidatesFor("insurance_per_day_cents", "$11.00 per day, billed as $80.00 per week").weekMismatch).toBe(true);
  });

  it("never reads a daily amount as escrow per settlement, and the target only from an amount counted by neither", () => {
    expect(candidatesFor("escrow_per_settlement_cents", "$10 per day").values).toEqual([]);
    expect(candidatesFor("escrow_target_cents", "$125 from each weekly settlement until it reaches $2,500").values).toEqual([250000]);
  });

  it("gives a range as a range, never a value", () => {
    expect(candidatesFor("advance_fee_cents", "a fee of $3 to $5 depending on the card")).toMatchObject({ range: [300, 500] });
  });

  it("reads no cap for the one nullable rule, and the enum rules from their words", () => {
    expect(candidatesFor("advance_recovery_cap_cents", "with no cap on the amount").values).toEqual([null]);
    expect(candidatesFor("advance_fee_cents", "with no cap on the amount").values).toEqual([]);
    expect(candidatesFor("insurance_applies_to", "Leased owner-operators are covered").values).toEqual(["owner_operator"]);
    expect(candidatesFor("insurance_applies_to", "Every driver, company or leased").values).toEqual(["all"]);
    expect(candidatesFor("percent_base", "of the linehaul and fuel surcharge").values).toEqual(["linehaul_fsc"]);
    expect(candidatesFor("percent_base", "of the line-haul, fuel surcharge and accessorial charges").values).toEqual([
      "linehaul_fsc_accessorials",
    ]);
    expect(candidatesFor("percent_base", "of the linehaul only").values).toEqual(["linehaul"]);
  });

  it("drops values out of the rule's range", () => {
    expect(candidatesFor("advance_max_bps_of_earned", "250 percent").values).toEqual([]);
  });
});

describe("the model's reading", () => {
  it("reads value text the same way, codes as themselves, and nothing from two values", () => {
    expect(valueFromText("insurance_per_day_cents", "$10.50")).toBe(1050);
    expect(valueFromText("insurance_per_day_cents", "10.50")).toBe(1050);
    expect(valueFromText("empty_miles_paid_bps", "half")).toBe(5000);
    expect(valueFromText("empty_miles_paid_bps", "80")).toBe(8000);
    expect(valueFromText("insurance_applies_to", "owner_operator")).toBe("owner_operator");
    expect(valueFromText("percent_base", "linehaul and fuel surcharge")).toBe("linehaul_fsc");
    expect(valueFromText("advance_recovery_cap_cents", "no cap")).toBeNull();
    expect(valueFromText("advance_recovery_cap_cents", "none")).toBeNull();
    expect(valueFromText("advance_fee_cents", "$3 to $5")).toBeUndefined();
    expect(valueFromText("advance_fee_cents", "none")).toBeUndefined();
  });
});
