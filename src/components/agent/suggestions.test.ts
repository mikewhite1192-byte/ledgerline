import { describe, expect, it } from "vitest";
import { homeSuggestions, ruleChangeSuggestion } from "./suggestions";

describe("homeSuggestions", () => {
  it("offers four questions, and margin per load in place of the advance limit while reports are on", () => {
    const off = homeSuggestions(false);
    const on = homeSuggestions(true);
    expect(off.map((s) => s.id)).toEqual(["paystub-problems", "past-60", "pay-run-cost", "advance-limit"]);
    expect(on.map((s) => s.id)).toEqual(["paystub-problems", "past-60", "pay-run-cost", "margin-per-load"]);
    expect(on[3].label).toBe("What was our margin per load this month?");
  });
});

describe("ruleChangeSuggestion", () => {
  it("fills an example dated the first week a change can start, with the help on how to say one", () => {
    expect(ruleChangeSuggestion("2026-11-02")).toEqual({
      id: "change-pay-rule",
      label: "Change a pay rule",
      fill: "Starting Nov 2, owner-operator insurance goes to $12 a day",
      help: "Say the rule, the new amount and the date it starts. Example: 'From Nov 9, escrow is $75 a week.'",
    });
  });
});
