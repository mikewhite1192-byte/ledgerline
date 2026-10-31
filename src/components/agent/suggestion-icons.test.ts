import { describe, expect, it } from "vitest";
import { nextWeekStart } from "@/lib/pay-rules/words";
import { FALLBACK_ICON, suggestionIcon } from "./suggestion-icons";
import { DETENTION_SUGGESTION, homeSuggestions, ruleChangeSuggestion, withPaystubSuggestion } from "./suggestions";

// Every combination of the switches that change the suggested questions.
function everyList() {
  const lists = [];
  for (const reportsOn of [false, true])
    for (const profitOn of [false, true])
      for (const quarterOn of [false, true])
        for (const collections of [false, true])
          for (const cashFridayOn of [false, true])
            lists.push(homeSuggestions(reportsOn, { profitOn, quarterOn, collections, cashFridayOn }));
  return lists;
}

describe("the suggested questions' icons", () => {
  it("gives every question the app can offer its own icon, never the fallback", () => {
    const start = nextWeekStart(new Date("2026-11-10T15:00:00Z"), "America/New_York", 1);
    const ids = new Set<string>([
      ...everyList().flatMap((l) => l.map((s) => s.id)),
      DETENTION_SUGGESTION.id,
      ruleChangeSuggestion(start).id,
      ...withPaystubSuggestion([], { driverName: "Dana Reyes", periodEnd: "2026-11-06" }).map((s) => s.id),
    ]);
    expect(ids.size).toBeGreaterThan(5);
    for (const id of ids) expect(suggestionIcon(id), id).not.toBe(FALLBACK_ICON);
  });

  it("gives an id it does not know the fallback, never a property of a plain object", () => {
    expect(suggestionIcon("not-a-question")).toBe(FALLBACK_ICON);
    expect(suggestionIcon("toString")).toBe(FALLBACK_ICON);
    expect(suggestionIcon("__proto__")).toBe(FALLBACK_ICON);
  });
});
