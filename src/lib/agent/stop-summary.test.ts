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

  it("always ends with the same last sentence and carries no amount of its own", () => {
    const text = stopSummary(list(["done", "doing", "todo"]), { steps: 3 });
    expect(text.endsWith(NOTHING_MOVED)).toBe(true);
    expect(text).not.toMatch(/\$/);
  });
});
