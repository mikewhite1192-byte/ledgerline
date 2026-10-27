import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import { parseTokens } from "./tokens";

const css = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8");

const { light, darkMedia, dark } = parseTokens(css);

// [foreground, background, floor]: 4.5 for text, 3.0 for borders and the focus ring.
const PAIRS: [string, string, number][] = [
  ["foreground", "background", 4.5],
  ["foreground", "card", 4.5],
  ["foreground", "secondary", 4.5],
  ["foreground-2", "background", 4.5],
  ["foreground-2", "card", 4.5],
  ["foreground-2", "secondary", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "card", 4.5],
  ["link", "card", 4.5],
  ["link", "background", 4.5],
  ["primary-foreground", "primary", 4.5],
  ["primary-foreground", "primary-hover", 4.5],
  ["success", "success-soft", 4.5],
  ["warning", "warning-soft", 4.5],
  ["warning", "card", 4.5],
  ["destructive", "destructive-soft", 4.5],
  ["destructive", "card", 4.5],
  ["destructive", "background", 4.5],
  ["destructive-foreground", "destructive", 4.5],
  ["info", "info-soft", 4.5],
  ["input", "card", 3],
  ["input", "background", 3],
  ["ring", "background", 3],
  ["ring", "card", 3],
];

describe("contrastRatio", () => {
  it("is 21 for white on black and 1 for a color on itself", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#0e6b4d", "#0e6b4d")).toBe(1);
  });

  it("refuses anything but #RRGGBB", () => {
    expect(() => contrastRatio("#fff", "#000000")).toThrow(RangeError);
  });
});

describe("globals.css tokens", () => {
  it("declare the same dark values for the system preference and for data-theme", () => {
    expect(darkMedia).toEqual(dark);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  for (const [mode, tokens] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it.each(PAIRS)(`${mode}: %s on %s meets %d`, (fg, bg, floor) => {
      expect(tokens[fg], fg).toMatch(/^#[0-9a-f]{6}$/);
      expect(tokens[bg], bg).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastRatio(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(floor);
    });
  }
});
