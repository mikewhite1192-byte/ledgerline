import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { composeReceipt, gradient, receiptLayout, type ComposeOptions } from "./compose";
import { receiptLines } from "./documents";
import { dots } from "./font";
import { SAMPLE_DOCS, isPhoto } from "./manifest";

// The composite carries the text layer exactly: drawn small on white, every pixel is read back
// and compared with the 64 x 64 picture the dot font says it must be.

const SMALL: ComposeOptions = { width: 64, height: 64, scale: 1, shadow: false };
const LINES = ["SAMPLE", "$1.00"];

async function white(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
}

describe("the composed receipt", () => {
  it("draws every line's dots on the card, and nothing else", async () => {
    const img = await composeReceipt(LINES, await white(), SMALL);
    const layout = receiptLayout(LINES, SMALL);
    const ink = new Set<string>();
    LINES.forEach((line, i) => {
      for (const [x, y] of dots(line)) {
        ink.add(`${layout.textLeft + x},${layout.textTop + i * layout.lineHeight + y}`);
      }
    });
    const { card } = layout;
    const onCard = (x: number, y: number) =>
      x >= card.left && x < card.left + card.width && y >= card.top && y < card.top + card.height;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const at = (y * 64 + x) * 4;
        const rgb = [img.data[at], img.data[at + 1], img.data[at + 2]];
        // Ink; the card (95% of 250, 248, 243 over white, rounded); or the untouched white page.
        const want = ink.has(`${x},${y}`)
          ? [34, 34, 34]
          : onCard(x, y)
            ? [250, 248, 244]
            : [255, 255, 255];
        expect(rgb, `pixel ${x},${y}`).toEqual(want);
      }
    }
  });

  it("fits every receipt at full size, on the gradient when there is no paper", async () => {
    for (const d of SAMPLE_DOCS.filter(isPhoto)) {
      expect(() => receiptLayout(receiptLines(d), { width: 1008, height: 1344, scale: 5, shadow: true }))
        .not.toThrow();
    }
    const g = gradient(4, 3);
    expect([...g.data.subarray(0, 4)]).toEqual([236, 233, 226, 255]);
    expect([...g.data.subarray(8 * 4, 8 * 4 + 4)]).toEqual([222, 218, 210, 255]);
    expect(() => receiptLayout(["X".repeat(20)], SMALL)).toThrow();
    expect(() => receiptLayout([], SMALL)).toThrow();
  });

  it("is the same pixels every time", async () => {
    const opts: ComposeOptions = { width: 200, height: 260, scale: 1, shadow: true };
    const a = await composeReceipt(LINES, null, opts);
    const b = await composeReceipt(LINES, null, opts);
    expect(a.data.equals(b.data)).toBe(true);
  });
});
