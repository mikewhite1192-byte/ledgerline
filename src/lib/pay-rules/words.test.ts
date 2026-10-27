import { describe, expect, it } from "vitest";
import {
  adminOnlyLabel,
  exampleSentence,
  impactLabel,
  impactLine,
  monthDay,
  nextWeekStart,
  paidUnderLine,
  REFUSAL_LINES,
  refusalLine,
  ruleTitle,
  savedLine,
  shortPeriod,
  startsLine,
  type ImpactWords,
} from "./words";

const SETTLED: ImpactWords = {
  basis: "settled_week",
  periodStart: "2026-10-12",
  periodEnd: "2026-10-18",
  driversChanged: 13,
  netDeltaCents: -6500,
  ownerOperatorsOnly: true,
  top: [{ code: "BR-D07", deltaCents: -500 }],
};

// Words a person never sees on screen (design 3a).
const INTERNAL = /proposal|tenant|ledger|executor|\bkind\b|status code|\bid\b|\bargs\b|cents|bps|basis point/i;

describe("the card's words", () => {
  it("titles a change with both values and its unit", () => {
    expect(ruleTitle({ ruleKey: "insurance_per_day_cents", oldValue: 1100, newValue: 1200, appliesTo: "owner_operator" })).toBe(
      "Owner-operator insurance: $11.00 to $12.00 per day",
    );
    expect(ruleTitle({ ruleKey: "escrow_per_settlement_cents", oldValue: 10000, newValue: 7500, appliesTo: "all" })).toBe(
      "Escrow per week: $100.00 to $75.00 per week",
    );
    expect(ruleTitle({ ruleKey: "empty_miles_paid_bps", oldValue: 0, newValue: 3500, appliesTo: "all" })).toBe(
      "Empty miles paid: 0% to 35%",
    );
    expect(ruleTitle({ ruleKey: "advance_recovery_cap_cents", oldValue: null, newValue: 20000, appliesTo: "all" })).toBe(
      "Advance cap: no cap to $200.00",
    );
    expect(ruleTitle({ ruleKey: "insurance_applies_to", oldValue: "owner_operator", newValue: "all", appliesTo: "owner_operator" })).toBe(
      "Who pays insurance: owner-operators to all drivers",
    );
  });

  it("says when it starts, and why when the date moved", () => {
    expect(startsLine({ effectiveFrom: "2026-11-02", askedFrom: "2026-11-02", snapped: false })).toBe("Starts Monday, Nov 2");
    expect(startsLine({ effectiveFrom: "2026-11-08", askedFrom: "2026-11-02", snapped: true })).toBe(
      "Starts Sunday, Nov 8 (the week of Nov 2 had already begun, so the change starts with the next full week)",
    );
  });

  it("says what it would have done to last week's pay", () => {
    expect(impactLine(SETTLED)).toBe(
      "On last week's pay (Oct 12 to 18) this would have paid 13 owner-operators $65.00 less in total; the largest change is $5.00 (Driver BR-D07).",
    );
    expect(impactLine({ ...SETTLED, ownerOperatorsOnly: false, driversChanged: 1, netDeltaCents: 300, top: [{ code: "BR-D01", deltaCents: 300 }] })).toBe(
      "On last week's pay (Oct 12 to 18) this would have paid 1 driver $3.00 more in total; the largest change is $3.00 (Driver BR-D01).",
    );
    expect(impactLine({ ...SETTLED, periodStart: "2026-10-26", periodEnd: "2026-11-01", driversChanged: 0, netDeltaCents: 0, top: [] })).toBe(
      "On last week's pay (Oct 26 to Nov 1) this would not have changed anyone's pay.",
    );
    expect(impactLine({ ...SETTLED, basis: "advances_only" })).toBe(
      "This changes what drivers may borrow; last week's pay is unchanged.",
    );
    expect(impactLine({ ...SETTLED, basis: "no_settled_week", periodStart: null, periodEnd: null })).toBe(
      "No week has been paid yet, so there is no past pay to compare this with.",
    );
  });

  it("labels the amount by which way it goes", () => {
    expect(impactLabel(-6500)).toBe("Would pay out less per week");
    expect(impactLabel(6500)).toBe("Would pay out more per week");
    expect(impactLabel(0)).toBe("No change to weekly pay");
  });

  it("names the admin amount in whole dollars", () => {
    expect(adminOnlyLabel(200000)).toBe("Ask an admin to save this (over $2,000 a week)");
    expect(adminOnlyLabel(150050)).toBe("Ask an admin to save this (over $1,500.50 a week)");
  });

  it("says what happened after a save", () => {
    expect(savedLine("2026-11-02")).toBe("Saved. Starts with the week of Nov 2. See it under Pay rules.");
    expect(paidUnderLine("2026-10-19")).toBe("Paid under rules from Oct 19");
  });

  it("writes short dates and spans", () => {
    expect(monthDay("2026-11-02")).toBe("Nov 2");
    expect(shortPeriod("2026-10-19", "2026-10-25")).toBe("Oct 19 to 25");
    expect(shortPeriod("2026-10-26", "2026-11-01")).toBe("Oct 26 to Nov 1");
  });
});

describe("the questions back", () => {
  it("has one fixed line per refusal, in plain words", () => {
    for (const [category, line] of Object.entries(REFUSAL_LINES)) {
      expect(refusalLine(category as keyof typeof REFUSAL_LINES)).toBe(line);
      expect(line).not.toMatch(INTERNAL);
      expect(line).not.toMatch(/\u2014/);
    }
    expect(refusalLine("value_not_in_message")).toBe("What should it change to? I did not see that amount in your message.");
    expect(refusalLine("bad_date")).toBe("When should it start? Give me a date.");
    expect(refusalLine("no_change")).toBe("That is the same as today's rule, so nothing to change.");
  });
});

describe("the home chip's sentence", () => {
  it("names the first week a change can start, in the carrier's zone and week shape", () => {
    // Tuesday Oct 27: Monday weeks start next on Nov 2, Sunday weeks on Nov 1.
    const tuesday = new Date("2026-10-27T15:00:00Z");
    expect(nextWeekStart(tuesday, "America/New_York", 1)).toBe("2026-11-02");
    expect(nextWeekStart(tuesday, "America/Chicago", 0)).toBe("2026-11-01");
    // Late Sunday night in Chicago is already Monday in UTC; the week is still the one of Oct 25.
    expect(nextWeekStart(new Date("2026-11-01T04:30:00Z"), "America/Chicago", 0)).toBe("2026-11-01");
    expect(exampleSentence("2026-11-02")).toBe("Starting Nov 2, owner-operator insurance goes to $12 a day");
  });
});
