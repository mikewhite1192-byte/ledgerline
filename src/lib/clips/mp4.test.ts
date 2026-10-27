import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { looksLike } from "../ai/providers/media";
import { MP4_BRANDS, MP4_LIMITS, readMp4Header } from "./mp4";
import { muxAvc } from "./mux";

const TINY = new Uint8Array(readFileSync(join(__dirname, "fixtures/tiny.mp4")));
const DEMO = new Uint8Array(readFileSync(join(__dirname, "../../../public/demo/dock-clip-br-l10216.mp4")));

// A constant-rate clip from the muxer, with fake sample data (the header reader never decodes).
function clip(frames: number, fps: number, width = 64, height = 64): Uint8Array {
  const bytes = muxAvc({
    width,
    height,
    timescale: fps * 1000,
    frameTicks: 1000,
    avcC: Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe0, 0),
    samples: Array.from({ length: frames }, (_, i) => ({ data: Uint8Array.of(0, 0, 0, 1, i & 0xff), key: i === 0 })),
  });
  if (!bytes) throw new Error("mux");
  return bytes;
}

const indexOf = (bytes: Uint8Array, text: string, from = 0) => {
  const want = Array.from(text, (c) => c.charCodeAt(0));
  for (let i = from; i + want.length <= bytes.length; i++) {
    if (want.every((b, j) => bytes[i + j] === b)) return i;
  }
  return -1;
};

// The first `from` after the sample description box (the ftyp brands also say avc1).
function replaceFourcc(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const out = bytes.slice();
  const want = Array.from(from, (c) => c.charCodeAt(0));
  for (let i = indexOf(out, "stsd"); i >= 0 && i + 4 <= out.length; i++) {
    if (want.every((b, j) => out[i + j] === b)) {
      out.set(Array.from(to, (c) => c.charCodeAt(0)), i);
      return out;
    }
  }
  throw new Error(`no ${from}`);
}

describe("readMp4Header", () => {
  it("reads the fixture and the demo clip from their headers", () => {
    expect(readMp4Header(TINY)).toEqual({
      ok: true,
      header: { codec: "avc1", width: 64, height: 64, fps: 2, frameCount: 2, durationMs: 1000 },
    });
    expect(readMp4Header(DEMO)).toEqual({
      ok: true,
      header: { codec: "avc1", width: 640, height: 360, fps: 8, frameCount: 144, durationMs: 18000 },
    });
  });

  it("refuses what is not an MP4, or is cut short, as not_mp4", () => {
    expect(readMp4Header(new Uint8Array())).toEqual({ ok: false, reason: "not_mp4" });
    expect(readMp4Header(Uint8Array.from("hello, this is not a video", (c) => c.charCodeAt(0)))).toEqual({
      ok: false,
      reason: "not_mp4",
    });
    expect(readMp4Header(TINY.slice(0, 200))).toEqual({ ok: false, reason: "not_mp4" });
    expect(readMp4Header("not bytes" as never)).toEqual({ ok: false, reason: "not_mp4" });
  });

  it("takes exactly the major brands the model wrapper takes, so the upload refuses the rest", () => {
    const branded = (brand: string) => {
      const out = TINY.slice();
      out.set(Array.from(brand, (c) => c.charCodeAt(0)), 8);
      return out;
    };
    for (const brand of MP4_BRANDS) {
      expect(readMp4Header(branded(brand)), brand).toMatchObject({ ok: true });
      expect(looksLike("video/mp4", branded(brand)), brand).toBe(true);
    }
    for (const brand of ["qt  ", "M4V ", "3gp4"]) {
      expect(readMp4Header(branded(brand)), brand).toEqual({ ok: false, reason: "not_mp4" });
      expect(looksLike("video/mp4", branded(brand)), brand).toBe(false);
    }
    // The same file type box with a 64-bit size puts the brand past offset 8, where the wrapper
    // does not look: refused here too.
    const ftypSize = new DataView(TINY.buffer, TINY.byteOffset).getUint32(0);
    const wide = new Uint8Array(TINY.length + 8);
    const view = new DataView(wide.buffer);
    view.setUint32(0, 1);
    wide.set(TINY.subarray(4, 8), 4);
    view.setUint32(8, 0);
    view.setUint32(12, ftypSize + 8);
    wide.set(TINY.subarray(8), 16);
    expect(readMp4Header(wide)).toEqual({ ok: false, reason: "not_mp4" });
    expect(looksLike("video/mp4", wide)).toBe(false);
  });

  it("refuses a codec it does not take and a rotated track", () => {
    expect(readMp4Header(replaceFourcc(TINY, "avc1", "mp4v"))).toEqual({ ok: false, reason: "codec" });
    // The muxer writes the identity matrix; 0x00010000 at its first slot becomes 0 (a rotation).
    const rotated = clip(10, 5);
    const at = indexOf(rotated, "tkhd");
    // Box type, then version and flags (4), times (8), track id (4), reserved (4), duration (4),
    // reserved (8), layer and group (4), volume and reserved (4): the matrix starts 44 bytes on.
    rotated.set([0, 0, 0, 0], at + 4 + 40);
    expect(readMp4Header(rotated)).toEqual({ ok: false, reason: "rotated" });
  });

  it("refuses sizes, lengths and frame counts outside the limits", () => {
    expect(readMp4Header(clip(10, 5, 32, 64))).toEqual({ ok: false, reason: "dimensions" });
    expect(readMp4Header(clip(10, 5, 64, 2000))).toEqual({ ok: false, reason: "dimensions" });
    expect(readMp4Header(clip(31 * 2, 31))).toEqual({ ok: false, reason: "dimensions" });
    expect(readMp4Header(clip(4, 5))).toEqual({ ok: false, reason: "too_short" });
    expect(readMp4Header(clip(21 * 5, 5))).toEqual({ ok: false, reason: "too_long" });
    expect(readMp4Header(clip(601, 30))).toEqual({ ok: false, reason: "too_many_frames" });
    expect(readMp4Header(clip(600, 30))).toMatchObject({ ok: true, header: { frameCount: 600, durationMs: 20000 } });
    expect(readMp4Header(TINY, { ...MP4_LIMITS, maxBytes: TINY.length - 1 })).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});
