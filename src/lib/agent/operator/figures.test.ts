import { describe, expect, it } from "vitest";
import { centsIn, maskFigures, WITHHELD } from "./figures";

describe("figures", () => {
  it("collects every value under a key ending in cents, as absolute values", () => {
    const found = centsIn({ grossCents: 150_000, lines: [{ amount_cents: -2_500 }, { limitCents: [100, 200] }], name: 5 });
    expect([...found].sort((a, b) => a - b)).toEqual([100, 200, 2_500, 150_000]);
  });

  it("keeps a figure a tool returned and withholds one it did not", () => {
    const allowed = new Set([222_500, 2_500, 1_500]);
    const out = maskFigures("Pay is $2,225.00, minus $25 and 1,500 cents; not $3,000.", allowed);
    expect(out.text).toBe(`Pay is $2,225.00, minus $25 and 1,500 cents; not ${WITHHELD}.`);
    expect(out.masked).toBe(1);
  });

  it("reads one decimal place as tens of cents", () => {
    expect(maskFigures("$1.5", new Set([150])).masked).toBe(0);
    expect(maskFigures("$1.5", new Set([105])).masked).toBe(1);
  });

  it("leaves text with no money alone", () => {
    expect(maskFigures("BR-D07 drove 2,400 miles", new Set())).toEqual({ text: "BR-D07 drove 2,400 miles", masked: 0 });
  });
});
