import { describe, expect, it } from "vitest";
import { dataUrl, dataUrlLength, fromBase64, IMAGE_MIMES, looksLike, pdfPages } from "./media";

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (s: string) => new Uint8Array([...Buffer.from(s, "latin1")]);

describe("dataUrl", () => {
  it("builds a base64 data URL, and its length is known without building it", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 300, 1_001]) {
      const data = new Uint8Array(n).fill(7);
      const url = dataUrl("image/png", data);
      expect(url.startsWith("data:image/png;base64,")).toBe(true);
      expect(dataUrlLength("image/png", n), String(n)).toBe(url.length);
    }
    // A view into a larger buffer encodes only its own bytes.
    const big = bytes(1, 2, 3, 4, 5, 6);
    expect(dataUrl("application/pdf", big.subarray(2, 4))).toBe(
      `data:application/pdf;base64,${Buffer.from([3, 4]).toString("base64")}`,
    );
  });
});

describe("looksLike", () => {
  it("knows each accepted type by its first bytes", () => {
    expect(IMAGE_MIMES).toEqual(["image/jpeg", "image/png", "image/gif", "image/webp"]);
    expect(looksLike("image/png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      true,
    );
    expect(looksLike("image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(looksLike("image/gif", ascii("GIF89a..."))).toBe(true);
    expect(looksLike("image/gif", ascii("GIF87a..."))).toBe(true);
    expect(looksLike("image/webp", ascii("RIFF\0\0\0\0WEBPVP8 "))).toBe(true);
    expect(looksLike("application/pdf", ascii("%PDF-1.7\n"))).toBe(true);
  });

  it("refuses a mislabeled, truncated or empty file", () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(looksLike("image/jpeg", png)).toBe(false);
    expect(looksLike("image/png", png.subarray(0, 4))).toBe(false);
    expect(looksLike("image/webp", ascii("RIFF\0\0\0\0WAVEfmt "))).toBe(false);
    expect(looksLike("application/pdf", ascii("%PDF"))).toBe(false);
    expect(looksLike("application/pdf", new Uint8Array())).toBe(false);
  });
});

describe("pdfPages", () => {
  it("counts declared pages, not the page tree", () => {
    const pdf = ascii(
      "%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] >>\n2 0 obj << /Type /Page >>\n3 0 obj <</Type/Page>>\n",
    );
    expect(pdfPages(pdf)).toBe(2);
  });

  it("assumes the 50-page cap when no page can be read, and never counts past it", () => {
    expect(pdfPages(ascii("%PDF-1.5\n(compressed object streams)"))).toBe(50);
    expect(pdfPages(ascii("%PDF-1.4\n" + "<< /Type /Page >>\n".repeat(80)))).toBe(50);
  });

  it("assumes the cap when a compressed object stream can hide more page objects", () => {
    // One page object is exposed; the rest could sit inside the object stream.
    const pdf = ascii(
      "%PDF-1.5\n2 0 obj << /Type /Page >>\n5 0 obj << /Type /ObjStm /N 39 /First 300 >>\nstream\n",
    );
    expect(pdfPages(pdf)).toBe(50);
  });
});

describe("fromBase64", () => {
  it("decodes standard padded base64", () => {
    expect([...(fromBase64("AQID") ?? [])]).toEqual([1, 2, 3]);
    expect([...(fromBase64("AQ==") ?? [])]).toEqual([1]);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "AQI", "AQ=", "A Q==", "AQ-_", "AQ==\n", 42, null, undefined]) {
      expect(fromBase64(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
