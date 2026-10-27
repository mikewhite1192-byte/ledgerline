import { describe, expect, it } from "vitest";
import { homeSuggestions, withPaystubSuggestion } from "./suggestions";

describe("homeSuggestions", () => {
  it("offers four questions, and margin per load in place of the advance limit while reports are on", () => {
    const off = homeSuggestions(false);
    const on = homeSuggestions(true);
    expect(off.map((s) => s.id)).toEqual(["paystub-problems", "past-60", "pay-run-cost", "advance-limit"]);
    expect(on.map((s) => s.id)).toEqual(["paystub-problems", "past-60", "pay-run-cost", "margin-per-load"]);
    expect(on[3].label).toBe("What was our margin per load this month?");
  });

  it("asks whether Friday's pay run can be made while Cash Friday is on", () => {
    expect(homeSuggestions(false, true).map((s) => s.id)).toEqual([
      "paystub-problems",
      "past-60",
      "make-pay-run",
      "advance-limit",
    ]);
    expect(homeSuggestions(true, true)[2].label).toBe("Can we make Friday's pay run?");
    expect(homeSuggestions(true, false)[2].label).toBe("What will Friday's pay run cost?");
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
