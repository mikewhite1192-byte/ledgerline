import { describe, expect, it } from "vitest";
import type { Checklist } from "./checklist";
import { NOTHING_MOVED, stopSummary } from "./stop-summary";

const list = (states: Checklist["items"][number]["state"][]): Checklist => ({
  v: 1,
  by: "model",
  items: states.map((state, i) => ({ key: `m${i + 1}`, text: ["Read Rosa's week", "Check her pay.", "Draft a fix"][i], state })),
});

describe("stopSummary", () => {
  it("says what was done and what is left, then that nothing was paid or sent", () => {
    expect(stopSummary(list(["done", "done", "not_done"]), { steps: 7 })).toBe(
      "I stopped after 7 steps. Done: Read Rosa's week; Check her pay. Not done: Draft a fix. Nothing was paid or sent.",
    );
  });

  it("says so when nothing was done yet, and leaves out an empty not done list", () => {
    expect(stopSummary(list(["not_done", "todo", "doing"]), { steps: 1 })).toBe(
      "I stopped after 1 step. Done: nothing yet. Not done: Read Rosa's week; Check her pay; Draft a fix. Nothing was paid or sent.",
    );
    expect(stopSummary(list(["done", "skipped", "done"]), { steps: 4 })).toBe(
      "I stopped after 4 steps. Done: Read Rosa's week; Draft a fix. Nothing was paid or sent.",
    );
  });

  it("counts the cards the run drafted, and never says nothing was done beside them", () => {
    expect(stopSummary(list(["not_done", "todo", "doing"]), { steps: 4, cards: 3 })).toBe(
      "I stopped after 4 steps. Drafted 3 cards so far, for a person to approve. Not done: Read Rosa's week; Check her pay; Draft a fix. Nothing was paid or sent.",
    );
    expect(stopSummary(list(["done", "doing", "todo"]), { steps: 2, cards: 1 })).toBe(
      "I stopped after 2 steps. Done: Read Rosa's week. Drafted 1 card so far, for a person to approve. Not done: Check her pay; Draft a fix. Nothing was paid or sent.",
    );
    // No cards is the text without them.
    expect(stopSummary(list(["not_done", "todo", "doing"]), { steps: 1, cards: 0 })).toBe(
      stopSummary(list(["not_done", "todo", "doing"]), { steps: 1 }),
    );
  });

  it("always ends with the same last sentence and carries no amount of its own", () => {
    const text = stopSummary(list(["done", "doing", "todo"]), { steps: 3 });
    expect(text.endsWith(NOTHING_MOVED)).toBe(true);
    expect(text).not.toMatch(/\$/);
  });
});
