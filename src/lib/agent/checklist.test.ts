import { describe, expect, it } from "vitest";
import {
  CHECKLIST_STATES,
  checklistArgs,
  checklistSchema,
  finalChecklist,
  modelChecklist,
  parseChecklist,
  type Checklist,
} from "./checklist";
import { WITHHELD } from "./operator/figures";

const item = (text: string, state?: string) => (state ? { text, state } : { text });

describe("checklist shape", () => {
  it("takes 1 to 12 items of 3 to 80 characters, each in a known state", () => {
    expect(CHECKLIST_STATES).toEqual(["todo", "doing", "done", "skipped", "not_done"]);
    expect(checklistArgs.safeParse({ items: [item("Read the week")] }).success).toBe(true);
    const twelve = Array.from({ length: 12 }, (_, i) => item(`Step number ${i + 1}`));
    expect(checklistArgs.safeParse({ items: twelve }).success).toBe(true);
    expect(checklistArgs.safeParse({ items: [...twelve, item("One too many")] }).success).toBe(false);
    expect(checklistArgs.safeParse({ items: [] }).success).toBe(false);
    expect(checklistArgs.safeParse({ items: [item("ab")] }).success).toBe(false);
    expect(checklistArgs.safeParse({ items: [item("x".repeat(80))] }).success).toBe(true);
    expect(checklistArgs.safeParse({ items: [item("x".repeat(81))] }).success).toBe(false);
    for (const state of CHECKLIST_STATES) {
      expect(checklistArgs.safeParse({ items: [item("Read the week", state)] }).success, state).toBe(true);
    }
    expect(checklistArgs.safeParse({ items: [item("Read the week", "finished")] }).success).toBe(false);
    // Strict: no tenant, no key, no other field.
    expect(checklistArgs.safeParse({ items: [{ text: "Read the week", key: "a" }] }).success).toBe(false);
    expect(checklistArgs.safeParse({ items: [item("Read the week")], tenantId: "x" }).success).toBe(false);
  });

  it("stores the model's list with keys by position, every state set and spaces collapsed", () => {
    const list = modelChecklist(
      { items: [{ text: "  Read   Rosa's\nweek ", state: "doing" }, { text: "Check her pay", state: "todo" }] },
      new Set(),
    );
    expect(list).toEqual({
      v: 1,
      by: "model",
      items: [
        { key: "m1", text: "Read Rosa's week", state: "doing" },
        { key: "m2", text: "Check her pay", state: "todo" },
      ],
    });
    expect(checklistSchema.safeParse(list).success).toBe(true);
  });

  it("withholds a figure no record gave, like an answer, and keeps one a record gave", () => {
    const list = modelChecklist(
      {
        items: [
          { text: "Pay Rosa $9,999.00 back", state: "todo" },
          { text: "Advance of $400.00 for Sam", state: "todo" },
        ],
      },
      new Set([40_000]),
    );
    expect(list.items[0].text).toBe(`Pay Rosa ${WITHHELD} back`);
    expect(list.items[1].text).toBe("Advance of $400.00 for Sam");
  });

  it("writes a kept dollar figure with its cents, and changes no value", () => {
    const list = modelChecklist(
      {
        items: [
          { text: "Propose $100 advance for approval", state: "todo" },
          { text: "Check the $1,234.5 balance and the $ 7 fee", state: "todo" },
          { text: "Hold back 50 cents", state: "todo" },
        ],
      },
      new Set([10_000, 123_450, 700, 50]),
    );
    expect(list.items.map((i) => i.text)).toEqual([
      "Propose $100.00 advance for approval",
      "Check the $1,234.50 balance and the $7.00 fee",
      "Hold back 50 cents",
    ]);
  });

  it("cuts a text the mask made too long, still within 80 characters", () => {
    const text = `${"Check the fuel line for ".padEnd(70, "x")} $1.00`;
    const list = modelChecklist({ items: [{ text, state: "todo" }] }, new Set());
    expect(list.items[0].text.length).toBeLessThanOrEqual(80);
    expect(list.items[0].text.endsWith("…")).toBe(true);
  });

  it("reads back only a well-formed list, from an object or its JSON text", () => {
    const good: Checklist = { v: 1, by: "run", items: [{ key: "find", text: "Find every pay problem", state: "done" }] };
    expect(parseChecklist(good)).toEqual(good);
    expect(parseChecklist(JSON.stringify(good))).toEqual(good);
    expect(parseChecklist(null)).toBeNull();
    expect(parseChecklist("not json")).toBeNull();
    expect(parseChecklist({ ...good, v: 2 })).toBeNull();
    expect(parseChecklist({ ...good, items: [] })).toBeNull();
    expect(parseChecklist({ ...good, items: [{ key: "BAD KEY", text: "Find it", state: "done" }] })).toBeNull();
  });
});

describe("the list as the answer ended", () => {
  const list: Checklist = {
    v: 1,
    by: "model",
    items: [
      { key: "m1", text: "Read the week", state: "done" },
      { key: "m2", text: "Check the pay", state: "doing" },
      { key: "m3", text: "Draft a fix", state: "todo" },
      { key: "m4", text: "Look at fuel", state: "skipped" },
      { key: "m5", text: "Ask the driver", state: "not_done" },
    ],
  };
  const states = (l: Checklist) => l.items.map((i) => i.state);

  it("marks the item in hand done when the answer finished, and never moves a planned one up", () => {
    expect(states(finalChecklist(list, "done"))).toEqual(["done", "done", "not_done", "skipped", "not_done"]);
  });

  it("marks the item in hand not done when the answer stopped or failed", () => {
    expect(states(finalChecklist(list, "partial"))).toEqual(["done", "not_done", "not_done", "skipped", "not_done"]);
    expect(states(finalChecklist(list, "failed"))).toEqual(["done", "not_done", "not_done", "skipped", "not_done"]);
  });

  it("keeps the texts and keys, and leaves the list it was given as it was", () => {
    const before = structuredClone(list);
    const after = finalChecklist(list, "done");
    expect(after.items.map((i) => [i.key, i.text])).toEqual(list.items.map((i) => [i.key, i.text]));
    expect(list).toEqual(before);
  });
});
