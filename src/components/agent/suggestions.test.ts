import { describe, expect, it } from "vitest";
import { DETENTION_SUGGESTION, homeSuggestions, withPaystubSuggestion } from "./suggestions";

describe("homeSuggestions", () => {
  it("offers four questions, and margin per load in place of the advance limit while reports are on", () => {
    const off = homeSuggestions(false);
    const on = homeSuggestions(true);
    expect(off.map((s) => s.id)).toEqual(["paystub-problems", "past-60", "pay-run-cost", "advance-limit"]);
    expect(on.map((s) => s.id)).toEqual(["paystub-problems", "past-60", "pay-run-cost", "margin-per-load"]);
    expect(on[3].label).toBe("What was our margin per load this month?");
  });

  it("keeps the first question word for word, since it is what the agent is asked", () => {
    expect(homeSuggestions(false)[0]).toEqual({
      id: "paystub-problems",
      label: "Who has a problem on this week's paystub?",
      reason: "Finds the paystubs that need a look before Friday.",
    });
  });
});

describe("every suggestion says why", () => {
  it("has a one-line reason under each chip, whatever is switched on", () => {
    const paystub = { driverName: "Dana Reyes", periodEnd: "2026-10-25" };
    const all = [
      ...homeSuggestions(false),
      ...homeSuggestions(true),
      DETENTION_SUGGESTION,
      ...withPaystubSuggestion(homeSuggestions(true), paystub),
    ];
    for (const s of all) {
      expect(s.reason.trim(), s.id).not.toBe("");
      expect(s.reason, s.id).toMatch(/^[A-Z].*\.$/);
      expect(s.reason, s.id).not.toBe(s.label);
    }
  });
});

describe("withPaystubSuggestion", () => {
  it("puts the paystub's question first, ahead of three of the usual four", () => {
    const out = withPaystubSuggestion(homeSuggestions(false), { driverName: "Dana Reyes", periodEnd: "2026-10-25" });
    expect(out.map((s) => s.id)).toEqual(["explain-paystub", "paystub-problems", "past-60", "pay-run-cost"]);
    expect(out[0].label).toBe("Explain Dana Reyes's paystub for the week ending Oct 25, 2026.");
    expect(out[0].reason).toBe("Walks through each line of this paystub in plain words.");
  });

  it("leaves the usual four alone without a paystub", () => {
    expect(withPaystubSuggestion(homeSuggestions(false), null)).toEqual(homeSuggestions(false));
  });
});
