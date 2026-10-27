import { describe, expect, it } from "vitest";
import { chordOf, keyName, sentence, summariesFrom, summarize, validAction, validateBatch } from "./actions";

describe("validAction", () => {
  it("types each documented action and keeps only its own fields", () => {
    expect(validAction({ type: "click", x: 0, y: 799, button: "left", extra: 1 })).toEqual({ type: "click", x: 0, y: 799, button: "left" });
    expect(validAction({ type: "double_click", x: 1279, y: 0 })).toEqual({ type: "double_click", x: 1279, y: 0 });
    expect(validAction({ type: "move", x: 5, y: 5 })).toEqual({ type: "move", x: 5, y: 5 });
    expect(validAction({ type: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })).toEqual({ type: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
    expect(validAction({ type: "keypress", keys: ["shift", "tab"] })).toEqual({ type: "keypress", keys: ["shift", "tab"] });
    expect(validAction({ type: "scroll", x: 10, y: 10, scroll_x: 0, scroll_y: -400 })).toEqual({ type: "scroll", x: 10, y: 10, scrollX: 0, scrollY: -400 });
    expect(validAction({ type: "type", text: "MC-123456" })).toEqual({ type: "type", text: "MC-123456" });
    expect(validAction({ type: "screenshot" })).toEqual({ type: "screenshot" });
    expect(validAction({ type: "wait" })).toEqual({ type: "wait" });
  });

  it.each([
    ["a click off the screen", { type: "click", x: 1280, y: 5, button: "left" }],
    ["a click with a fractional pixel", { type: "click", x: 1.5, y: 5, button: "left" }],
    ["a click with an unknown button", { type: "click", x: 1, y: 1, button: "middle" }],
    ["a negative point", { type: "move", x: -1, y: 1 }],
    ["a drag of one point", { type: "drag", path: [{ x: 1, y: 1 }] }],
    ["a drag of 21 points", { type: "drag", path: Array.from({ length: 21 }, () => ({ x: 1, y: 1 })) }],
    ["a key chord with ctrl", { type: "keypress", keys: ["ctrl", "a"] }],
    ["three keys", { type: "keypress", keys: ["shift", "a", "b"] }],
    ["a function key", { type: "keypress", keys: ["F12"] }],
    ["a huge scroll", { type: "scroll", x: 1, y: 1, scroll_x: 0, scroll_y: 5_001 }],
    ["typed text over 200 characters", { type: "type", text: "a".repeat(201) }],
    ["typed control characters", { type: "type", text: "line\nbreak" }],
    ["empty typed text", { type: "type", text: "" }],
    ["an undocumented type", { type: "navigate", url: "https://example.test" }],
  ])("refuses %s", (_name, raw) => {
    expect(validAction(raw)).toBeNull();
  });
});

describe("keys", () => {
  it("maps letters, digits and named keys, and Shift only as a prefix", () => {
    expect(keyName("A")).toBe("a");
    expect(keyName("7")).toBe("7");
    expect(keyName("ENTER")).toBe("Enter");
    expect(keyName("toString")).toBeNull();
    expect(chordOf(["Enter"])).toBe("Enter");
    expect(chordOf(["shift", "a"])).toBe("Shift+A");
    expect(chordOf(["shift", "tab"])).toBe("Shift+Tab");
    expect(chordOf(["a", "shift"])).toBeNull();
    expect(chordOf([])).toBeNull();
  });
});

describe("validateBatch", () => {
  const click = { type: "click", x: 1, y: 1, button: "left" };
  it("refuses an empty batch, one over the cap, and any batch with one bad action", () => {
    expect(validateBatch([], 8)).toEqual({ ok: false, reason: "empty_batch" });
    expect(validateBatch(Array.from({ length: 9 }, () => click), 8)).toEqual({ ok: false, reason: "too_many_actions" });
    expect(validateBatch([click, { type: "click", x: 9_999, y: 1, button: "left" }], 8)).toEqual({ ok: false, reason: "invalid_action" });
    expect(validateBatch([click, { type: "wait" }], 8)).toEqual({ ok: true, actions: [{ ...click, button: "left" }, { type: "wait" }] });
  });
});

describe("summaries", () => {
  it("never keeps typed text or pressed letters and digits", () => {
    const s = summarize([
      { type: "type", text: "ABCD2345" },
      { type: "keypress", keys: ["7"] },
      { type: "keypress", keys: ["shift", "q"] },
      { type: "click", x: 3, y: 4, button: "right" },
      { type: "navigate", url: "https://example.test" },
    ]);
    expect(s).toEqual([
      { type: "type", chars: 8 },
      { type: "keypress", keys: ["Digit"] },
      { type: "keypress", keys: ["Shift", "Letter"] },
      { type: "click", x: 3, y: 4, button: "right" },
      { type: "unknown" },
    ]);
    expect(JSON.stringify(s)).not.toContain("ABCD2345");
    expect(s.map(sentence)).toEqual([
      "Type 8 characters",
      "Press Digit",
      "Press Shift+Letter",
      "Click (right button) at 3, 4",
      "An action the runner does not allow",
    ]);
  });

  it("reads stored summaries back, dropping anything not in the expected shape", () => {
    expect(summariesFrom([{ type: "click", x: 1, y: 2, button: "left", text: "secret" }, "junk", { x: 1 }, { type: "keypress", keys: ["a"] }])).toEqual([
      { type: "click", x: 1, y: 2, button: "left" },
      { type: "keypress", keys: ["Letter"] },
    ]);
    expect(summariesFrom("not a list")).toEqual([]);
  });
});
