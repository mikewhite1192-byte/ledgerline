import { describe, expect, it } from "vitest";
import { isPayCardPng, pngSize } from "./png";

// The size check reads the PNG's own header: the signature, then IHDR's width and height.

function header(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("pay card PNG", () => {
  it("reads the size from the header", () => {
    expect(pngSize(header(1080, 1350))).toEqual({ width: 1080, height: 1350 });
    expect(isPayCardPng(header(1080, 1350), 400_000)).toBe(true);
  });

  it("refuses any other size", () => {
    expect(isPayCardPng(header(1079, 1350), 400_000)).toBe(false);
    expect(isPayCardPng(header(1080, 1351), 400_000)).toBe(false);
    expect(isPayCardPng(header(1350, 1080), 400_000)).toBe(false);
  });

  it("refuses a file that is not a PNG, is cut short or is too big", () => {
    const jpegish = header(1080, 1350);
    jpegish[0] = 0xff;
    expect(pngSize(jpegish)).toBeNull();
    const notIhdr = header(1080, 1350);
    notIhdr[12] = 0x58;
    expect(pngSize(notIhdr)).toBeNull();
    const wrongLength = header(1080, 1350);
    wrongLength[11] = 14;
    expect(pngSize(wrongLength)).toBeNull();
    expect(pngSize(header(1080, 1350).subarray(0, 23))).toBeNull();
    expect(isPayCardPng(new Uint8Array(0), 400_000)).toBe(false);
    expect(isPayCardPng(header(1080, 1350), 32)).toBe(false);
  });
});
