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

  it("asks who needs a payment reminder in the fourth place only while collections is on", () => {
    for (const reportsOn of [false, true]) {
      const on = homeSuggestions(reportsOn, { collections: true });
      expect(on.map((s) => s.id)).toEqual(["paystub-problems", "past-60", "pay-run-cost", "payment-reminder"]);
      expect(on[3].label).toBe("Who needs a payment reminder?");
    }
    expect(homeSuggestions(false, { collections: false })).toEqual(homeSuggestions(false));
    expect(homeSuggestions(true, { collections: false })).toEqual(homeSuggestions(true));
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
