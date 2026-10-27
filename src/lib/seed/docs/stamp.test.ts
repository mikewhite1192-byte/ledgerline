import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { GLYPH_HEIGHT, dots } from "./font";
import { PHOTO_SAMPLE_SENTENCE } from "./manifest";
import {
  TooLargeError,
  bandHeight,
  encodeWebp,
  exifDescription,
  imageDescription,
  pngOf,
  stampLayout,
  stampRgba,
  toRgba,
  underBand,
} from "./stamp";

const SIZE = 64;
const GRAY = 128;

async function grayFixture(): Promise<Buffer> {
  return sharp({
    create: { width: SIZE, height: SIZE, channels: 3, background: { r: GRAY, g: GRAY, b: GRAY } },
  })
    .png()
    .toBuffer();
}

describe("the SAMPLE stamp", () => {
  it("darkens the bottom band and writes SAMPLE in white dots, leaving the rest alone", async () => {
    const stamped = stampRgba(await toRgba(await grayFixture()));
    // Through a lossless PNG and back, as a file would be read.
    const back = await toRgba(await pngOf(stamped));
    const { band, scale, left, top } = stampLayout(SIZE, SIZE);
    expect(band).toBe(8);
    expect(scale).toBe(1);
    const lit = new Set(dots("SAMPLE").map(([x, y]) => `${left + x},${top + y}`));
    expect(lit.size).toBeGreaterThan(40);
    const px = (x: number, y: number) => [...back.data.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3)];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const want =
          y < SIZE - band ? GRAY : lit.has(`${x},${y}`) ? 255 : underBand(GRAY);
        expect(px(x, y), `pixel ${x},${y}`).toEqual([want, want, want]);
      }
    }
    // 0.28 x 128 + 0.72 x 17, rounded.
    expect(underBand(GRAY)).toBe(48);
    expect(top + GLYPH_HEIGHT * scale).toBeLessThanOrEqual(SIZE);
  });

  it("sizes the band to 6% of the height and the word to the band", () => {
    expect(bandHeight(1344)).toBe(81);
    expect(stampLayout(1008, 1344)).toEqual({ band: 81, scale: 6, left: 399, top: 1282 });
  });

  it("writes the SAMPLE sentence into the webp's EXIF and reads it back", async () => {
    const img = stampRgba(await toRgba(await grayFixture()));
    const webp = await encodeWebp(img, PHOTO_SAMPLE_SENTENCE);
    expect(webp.toString("latin1", 8, 12)).toBe("WEBP");
    expect(await imageDescription(webp)).toBe(PHOTO_SAMPLE_SENTENCE);
    expect(await imageDescription(await pngOf(img))).toBeNull();
    await expect(encodeWebp(img, PHOTO_SAMPLE_SENTENCE, 10)).rejects.toThrow(TooLargeError);
  });

  it("parses both byte orders and refuses a broken block", () => {
    const tiff = (le: boolean, text: string) => {
      const value = Buffer.from(`${text}\0`, "latin1");
      const head = Buffer.alloc(8 + 2 + 12 + 4);
      const w16 = (v: number, at: number) => (le ? head.writeUInt16LE(v, at) : head.writeUInt16BE(v, at));
      const w32 = (v: number, at: number) => (le ? head.writeUInt32LE(v, at) : head.writeUInt32BE(v, at));
      head.write(le ? "II" : "MM", 0, "latin1");
      w16(42, 2);
      w32(8, 4);
      w16(1, 8);
      w16(0x010e, 10);
      w16(2, 12);
      w32(value.length, 14);
      w32(head.length, 18);
      return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), head, value]);
    };
    expect(exifDescription(tiff(true, "SAMPLE: le"))).toBe("SAMPLE: le");
    expect(exifDescription(tiff(false, "SAMPLE: be"))).toBe("SAMPLE: be");
    expect(exifDescription(Buffer.from("Exif\0\0XX", "latin1"))).toBeNull();
    expect(exifDescription(tiff(true, "x").subarray(0, 20))).toBeNull();
  });
});
