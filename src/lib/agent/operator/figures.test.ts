import { describe, expect, it } from "vitest";
import { centsIn, houseDollars, maskFigures, typedCentsIn, WITHHELD } from "./figures";

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

  it("reads the person's typed figures as cents, the same way the mask reads them", () => {
    const typed = typedCentsIn("Can Sam get $500, or $1,250.5, or 75 cents?");
    expect([...typed].sort((a, b) => a - b)).toEqual([75, 50_000, 125_050]);
    expect(maskFigures("Yes, $500.00 and $1,250.50 and 75 cents, not $501.", typed)).toEqual({
      text: `Yes, $500.00 and $1,250.50 and 75 cents, not ${WITHHELD}.`,
      masked: 1,
    });
    expect([...typedCentsIn("BR-D07 drove 2,400 miles")]).toEqual([]);
  });

  it("judges a per-gallon rate as one whole token, never as $0 and a suffix", () => {
    for (const allowed of [new Set<number>(), new Set([0, 29, 2_900, 29_000])]) {
      const out = maskFigures("AL is $0.2900 a gallon; IN is $0.28512.", allowed);
      expect(out).toEqual({ text: `AL is ${WITHHELD} a gallon; IN is ${WITHHELD}.`, masked: 2 });
    }
    expect(houseDollars("AL is $0.2900 a gallon.")).toBe("AL is $0.2900 a gallon.");
    expect([...typedCentsIn("Use $3.657 a gallon")]).toEqual([]);
  });

  it("reads two decimals, thousands, a sign and a closing period exactly as before", () => {
    const allowed = new Set([2_102, 123_456, 2_500, 150]);
    expect(maskFigures("Tax is $21.02. Owed -$1,234.56, $25 and $1.5.", allowed)).toEqual({
      text: "Tax is $21.02. Owed -$1,234.56, $25 and $1.5.",
      masked: 0,
    });
    expect(maskFigures("Not $21.03.", allowed)).toEqual({ text: `Not ${WITHHELD}.`, masked: 1 });
    expect(houseDollars("Owed $25. Then $1,234.5.")).toBe("Owed $25.00. Then $1,234.50.");
    expect([...typedCentsIn("Send $1,234.56.")]).toEqual([123_456]);
  });

  it("leaves text with no money alone", () => {
    expect(maskFigures("BR-D07 drove 2,400 miles", new Set())).toEqual({ text: "BR-D07 drove 2,400 miles", masked: 0 });
  });
});
