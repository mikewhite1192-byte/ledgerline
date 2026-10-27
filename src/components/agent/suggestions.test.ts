import { describe, expect, it } from "vitest";
import { homeSuggestions } from "./suggestions";

describe("homeSuggestions", () => {
  it("offers four questions, and margin per load in place of the advance limit while reports are on", () => {
    const off = homeSuggestions(false);
    const on = homeSuggestions(true);
    expect(off.map((s) => s.id)).toEqual(["paystub-problems", "past-60", "pay-run-cost", "advance-limit"]);
    expect(on.map((s) => s.id)).toEqual(["paystub-problems", "past-60", "pay-run-cost", "margin-per-load"]);
    expect(on[3].label).toBe("What was our margin per load this month?");
  });
});
