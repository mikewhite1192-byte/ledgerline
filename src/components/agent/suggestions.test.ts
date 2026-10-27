import { describe, expect, it } from "vitest";
import { homeSuggestions, ruleChangeSuggestion, withPaystubSuggestion } from "./suggestions";

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
      help: "Say the rule, the new amount and the date it starts. Example: 'From Nov 9, the net pay floor is $350 a week.'",
    });
  });
});

describe("withPaystubSuggestion", () => {
  it("puts the paystub's question first, ahead of three of the usual four", () => {
    const out = withPaystubSuggestion(homeSuggestions(false), { driverName: "Dana Reyes", periodEnd: "2026-10-25" });
    expect(out.map((s) => s.id)).toEqual(["explain-paystub", "paystub-problems", "past-60", "pay-run-cost"]);
    expect(out[0].label).toBe("Explain Dana Reyes's paystub for the week ending Oct 25, 2026.");
  });

  it("leaves the usual four alone without a paystub", () => {
    expect(withPaystubSuggestion(homeSuggestions(false), null)).toEqual(homeSuggestions(false));
  });
});
