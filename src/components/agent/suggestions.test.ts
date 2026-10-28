import { describe, expect, it } from "vitest";
import { nextWeekStart } from "@/lib/pay-rules/words";
import { DETENTION_SUGGESTION, homeSuggestions, ruleChangeSuggestion, withPaystubSuggestion } from "./suggestions";

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

  it("asks how last week went in that place while the profit brief is on, reports on or off", () => {
    for (const reportsOn of [false, true]) {
      const out = homeSuggestions(reportsOn, { profitOn: true });
      expect(out.map((s) => s.id)).toEqual(["paystub-problems", "past-60", "pay-run-cost", "profit-brief"]);
      expect(out[3].label).toBe("How did we do last week?");
    }
    expect(homeSuggestions(false, { profitOn: false })).toEqual(homeSuggestions(false));
    expect(homeSuggestions(true, {})).toEqual(homeSuggestions(true));
    expect(homeSuggestions(true, { profitOn: true, collections: true })[3].id).toBe("profit-brief");
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
      ...homeSuggestions(false, { profitOn: true }),
      ...homeSuggestions(false, { collections: true }),
      DETENTION_SUGGESTION,
      ruleChangeSuggestion("2026-11-02"),
      ...withPaystubSuggestion(homeSuggestions(true), paystub),
    ];
    for (const s of all) {
      expect(s.reason.trim(), s.id).not.toBe("");
      expect(s.reason, s.id).toMatch(/^[A-Z].*\.$/);
      expect(s.reason, s.id).not.toBe(s.label);
    }
  });
});

describe("ruleChangeSuggestion", () => {
  it("fills an example dated the first week a change can start, with the help on how to say one", () => {
    expect(ruleChangeSuggestion("2026-11-02")).toEqual({
      id: "change-pay-rule",
      label: "Change a pay rule",
      reason: "Shows what the change does to pay; nothing is saved until you approve.",
      fill: "Starting Nov 2, owner-operator insurance goes to $12 a day",
      help: "Say the rule, the new amount and the date it starts. Example: 'From Nov 2, the net pay floor is $350 a week.'",
    });
  });

  it("dates the help's example by the same week as the sentence, so it moves on after Nov 9", () => {
    // Tuesday Nov 10, 2026: a fixed example dated Nov 9 would name a week that has begun.
    const nextStart = nextWeekStart(new Date("2026-11-10T15:00:00Z"), "America/New_York", 1);
    expect(nextStart).toBe("2026-11-16");
    const s = ruleChangeSuggestion(nextStart);
    expect(s.fill).toBe("Starting Nov 16, owner-operator insurance goes to $12 a day");
    expect(s.help).toBe(
      "Say the rule, the new amount and the date it starts. Example: 'From Nov 16, the net pay floor is $350 a week.'",
    );
    expect(s.help).not.toContain("Nov 9");
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
